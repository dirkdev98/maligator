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
import { validateNativeStackObject } from "../src/compiler/target/native-stack-object.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";

function config(primordials: "mutable" | "locked") {
	return resolveBuildConfig({ engine: { primordials, eval: false, realms: false } });
}
function compile(body: string) {
	return compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(
			`globalThis.inspect=function inspect(input,flag,descriptor){${body}};`,
			"known-object.js",
		),
		{ facts: compilerProgramFactsFromConfig(config("locked")) },
	);
}
function named(image: ReturnType<typeof compile>, name = "inspect") {
	return image.native.functions.find(
		(fn) =>
			String.fromCharCode(
				...(image.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
			) === name,
	)!;
}
function sites(fn: ReturnType<typeof named>) {
	return fn.specializations.flatMap((region) =>
		region.kind === "stack-object-plan" ? region.sites : [],
	);
}

describe("known builtin object observation", () => {
	it.each(["mutable", "locked"] as const)(
		"retains bundled builtin observation regions under %s primordials",
		(primordials) => {
			const buildConfig = config(primordials);
			const image = compileSemanticProgramToProgramImage(
				loadEntrypointAndRunSemanticAnalysis(
					resolve("tests/local/known-object-observation.js"),
					{ buildConfig, stripTypes: stripCompactTypes },
				),
				{ facts: compilerProgramFactsFromConfig(buildConfig) },
			);
			for (const name of [
				"freezeRead",
				"freezeWrite",
				"sealRead",
				"descriptorRead",
				"assignRead",
				"builtinAlias",
				"mixedFreeze",
			]) {
				const fn = named(image, name);
				const observed = sites(fn)
					.flatMap((site) => site.materializations)
					.filter((entry) => entry.kind === "observe");
				expect(observed.length, name).toBeGreaterThan(0);
				if (primordials === "locked")
					expect(
						observed.some(
							(entry) => fn.body.instructions[entry.ip]?.opcode === "CALL_KNOWN",
						),
						name,
					).toBe(true);
				const output = emitCompiledFunction(fn, fn.functionIndex, "", false)!.source;
				expect(output).toContain("mal_vm_materialize_stack_object");
			}
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
				image,
			);
		},
	);

	it("publishes live roots before materializing an argument and preserves the known call result", () => {
		const image = compile(
			"const object={x:input,y:2};const held=globalThis.observe();const result=Object.freeze(object);globalThis.observe(held,result);return [object.x,result===object];",
		);
		const fn = named(image),
			site = sites(fn)[0]!;
		const observation = site.materializations.find(
			(entry) => fn.body.instructions[entry.ip]?.opcode === "CALL_KNOWN",
		)!;
		const call = fn.body.instructions[observation.ip]!;
		if (call.opcode !== "CALL_KNOWN") throw new Error("Missing known observer");
		const held = fn.body.instructions
			.slice(0, observation.ip)
			.findLast((op) => op.opcode === "CALL")!;
		if (held.opcode !== "CALL") throw new Error("Missing preceding call");
		const point = fn.gc.safepoints.find(
			(point) => point.instructionIp === observation.ip,
		)!;
		expect(point.incomingRootRegisters).toContain(held.dst);
		expect(point.outgoingRootRegisters).toContain(call.dst);
		const output = emitCompiledFunction(fn, fn.functionIndex, "", false)!.source;
		const heldResult = output.indexOf(
			`r${held.dst} = call_result_${fn.body.instructions.indexOf(held)}.value;`,
		);
		const materialize = output.indexOf("mal_vm_materialize_stack_object", heldResult);
		expect(materialize).toBeGreaterThan(heldResult);
		expect(output.slice(heldResult, materialize)).toMatch(
			new RegExp(`\\n    __gc_slots\\[\\d+\\] = r${held.dst};\\n`),
		);
		expect(output.slice(materialize)).toContain("mal_vm_op_load_property_ic");
	});

	it.each([
		"const object={x:input,y:2};Object.freeze.apply(null,object);return object.x;",
		"const object={x:input,y:2};new Map(object);return object.x;",
		"const object={x:input,y:2,toString:descriptor};globalThis.last=Object.prototype.toLocaleString.call(object);return object.x;",
		"const object={x:input,y:2};try{Object.freeze(object);}catch(error){return object.x;}return object.y;",
		"let prior;for(let i=0;i<2;i++){const object={x:input,y:2};if(prior)Object.freeze(prior);prior=object;}return prior.x;",
	])("declines unsupported observer positions or lifetimes: %s", (body) => {
		const fn = named(compile(body));
		expect(fn.body.instructions.some((op) => op.opcode === "CALL_KNOWN")).toBe(true);
		expect(sites(fn)).toEqual([]);
	});

	it("independently rejects forged known call receiver, constructor, spread, and missing observation metadata", () => {
		const image = compile(
			"const object={x:input,y:2};if(flag)Object.freeze(object);return object.x+object.y;",
		);
		const fn = named(image),
			site = sites(fn)[0]!;
		const observation = site.materializations.find((entry) => entry.kind === "observe")!;
		const call = fn.body.instructions[observation.ip]!;
		if (call.opcode !== "CALL_KNOWN") throw new Error("Missing known observer");
		for (const forged of [
			{ ...call, thisValue: call.arguments[0]! },
			{ ...call, construct: true as const },
			{ ...call, argumentMode: "array-like" as const },
		])
			expect(() =>
				validateNativeStackObject(
					fn.body.instructions.with(observation.ip, forged),
					site,
					fn.body.handlers,
				),
			).toThrow(/Invalid stack-object/);
		expect(() =>
			validateNativeStackObject(
				fn.body.instructions,
				{ ...site, materializations: [] },
				fn.body.handlers,
			),
		).toThrow(/Invalid stack-object/);
		const forged = structuredClone(image);
		const target = named(forged);
		const region = target.specializations.find(
			(entry) => entry.kind === "stack-object-plan",
		)!;
		if (region.kind !== "stack-object-plan") throw new Error("Missing region");
		(region.sites[0]!.materializations as Array<unknown>).length = 0;
		expect(() => serializeCompilerArtifact(forged)).toThrow();
	});
});
