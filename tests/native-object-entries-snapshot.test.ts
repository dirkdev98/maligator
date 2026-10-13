import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { stripCompactTypes } from "../src/compiler/frontend/compact-type-strip.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { loadEntrypointAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-program.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import { compilerProgramFactsFromConfig } from "../src/compiler/shared/compiler-facts.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";

function compile(body: string, primordials: "mutable" | "locked" = "mutable") {
	return compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(
			`globalThis.inspect=function inspect(record,index,observe){${body}};`,
			"entries.js",
		),
		{
			facts: compilerProgramFactsFromConfig(
				resolveBuildConfig({ engine: { primordials } }),
			),
		},
	);
}
function inspect(image: ReturnType<typeof compile>) {
	return image.native.functions.find(
		(fn) =>
			String.fromCharCode(
				...(image.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
			) === "inspect",
	)!;
}

describe("Object.entries snapshot transport", () => {
	it.each(["mutable", "locked"] as const)(
		"admits bundled count, pair and materializing observations under %s primordials",
		(primordials) => {
			const config = resolveBuildConfig({
				engine: { primordials, eval: false, realms: false },
				surface: { node: true },
			});
			const semantic = loadEntrypointAndRunSemanticAnalysis(
				resolve("tests/local/object-entries-snapshot.js"),
				{ buildConfig: config, stripTypes: stripCompactTypes },
			);
			const image = compileSemanticProgramToProgramImage(semantic, {
				facts: compilerProgramFactsFromConfig(config),
			});
			for (const name of [
				"entriesCount",
				"entriesIndex",
				"entriesMaterialize",
				"entriesRead",
			]) {
				const fn = image.native.functions.find(
					(fn) =>
						String.fromCharCode(
							...(image.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
						) === name,
				)!;
				const plan = fn.storage!.objectEnumerationSnapshots.find(
					(plan) => plan.kind === "entries",
				);
				expect(plan, name).toBeDefined();
				const output = emitCompiledFunction(fn, fn.functionIndex, "", false)!.source;
				expect(output).toContain("MAL_OBJECT_ENUMERATION_ENTRIES");
				if (name !== "entriesCount")
					expect(output).toContain("mal_builtin_object_enumeration_entry(vm,");
			}
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
				image,
			);
		},
	);

	it("publishes unrelated live values before a numeric pair allocation and roots its result before polling", () => {
		const image = compile(
			`const entries=Object.entries(record);const numeric=+index;const held=observe(record);const pair=entries[numeric];observe(held,pair);return [entries.length,pair];`,
		);
		const fn = inspect(image),
			plan = fn.storage!.objectEnumerationSnapshots[0]!;
		expect(plan.kind).toBe("entries");
		const ip = plan.elementIps[0]!;
		const point = fn.gc.safepoints.find((point) => point.instructionIp === ip)!;
		expect(point).toBeDefined();
		const heldCall = fn.body.instructions
			.slice(0, ip)
			.findLast((op) => op.opcode === "CALL")!;
		if (heldCall.opcode !== "CALL") throw new Error("Missing observer call");
		expect(point.rootRegisters).toContain(heldCall.dst);
		const output = emitCompiledFunction(fn, fn.functionIndex, "", false)!.source;
		const pairCall = output.indexOf("mal_builtin_object_enumeration_entry(vm,");
		const poll = output.indexOf("mal_gc_safepoint(vm)", pairCall);
		expect(pairCall).toBeGreaterThan(0);
		expect(poll).toBeGreaterThan(pairCall);
		const load = fn.body.instructions[ip]!;
		if (load.opcode !== "LOAD_PROPERTY") throw new Error("Missing pair load");
		expect(output.slice(pairCall, poll)).toMatch(
			new RegExp(`__gc_slots\\[\\d+\\] = r${load.dst};`),
		);
		const heldIp = fn.body.instructions.indexOf(heldCall);
		const heldResult = output.indexOf(`r${heldCall.dst} = call_result_${heldIp}.value;`);
		expect(heldResult).toBeGreaterThan(0);
		const publication = output.slice(heldResult, pairCall);
		expect(publication).toContain("MAL_ROOT_MASK(");
		expect(publication).toMatch(
			new RegExp(`\\n    __gc_slots\\[\\d+\\] = r${heldCall.dst};\\n`),
		);
	});

	it.each([
		"const entries=Object.entries(record);observe(entries);return entries.length;",
		"let entries=Object.entries(record);if(index)entries=[];return entries[0];",
		"const entries=Object.entries(record);try{observe();}catch(error){return entries[0];}return entries.length;",
		"let prior;for(let i=0;i<2;i++){const entries=Object.entries(record);if(prior)observe(prior[0]);prior=entries;}return prior.length;",
	])("declines uncovered observations and lifetimes: %s", (body) => {
		expect(inspect(compile(body)).storage!.objectEnumerationSnapshots).toEqual([]);
	});

	it("rejects forged method kinds and missing element claims independently of the encoded plan", () => {
		const image = compile(
			"const entries=Object.entries(record);observe(record);return [entries[index],entries.length];",
		);
		const fn = inspect(image),
			plan = fn.storage!.objectEnumerationSnapshots[0]!;
		for (const forged of [
			{ ...plan, kind: "values" as const },
			{ ...plan, elementIps: [] },
			{ ...plan, claimedIps: [plan.callIp] },
		]) {
			expect(() =>
				serializeCompilerArtifact({
					...image,
					native: {
						...image.native,
						functions: image.native.functions.with(image.native.functions.indexOf(fn), {
							...fn,
							storage: { ...fn.storage!, objectEnumerationSnapshots: [forged] },
						}),
					},
				}),
			).toThrow(/invalid or stale storage plan/);
		}
	});
});
