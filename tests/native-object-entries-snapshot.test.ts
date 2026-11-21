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
import { lowerNativeStorage } from "../src/compiler/target/lower-native-storage.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";

function compile(body: string, primordials: "mutable" | "locked" = "mutable") {
	return lowerNativeStorage(
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`globalThis.inspect=function inspect(record,index,observe){${body}};`,
				"entries.js",
			),
			{
				facts: compilerProgramFactsFromConfig(
					resolveBuildConfig({ engine: { primordials } }),
				),
			},
		),
		"precise",
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
	it.each([
		"const pair=entries[index];return [pair[0],pair[1],entries.length];",
		"const pair=entries[+index];observe(record);return [pair[0],pair[1]];",
		"const pair=entries[0];return [pair['0'],pair['1']];",
		"let total=0;for(let i=0;i<entries.length;i++){const pair=entries[i];total+=pair[0].length+pair[1];}return total;",
	])("projects closed key/value observations: %s", (body) => {
		const image = compile(`const entries=Object.entries(record);observe(record);${body}`);
		const fn = inspect(image),
			plan = fn.storage!.objectEnumerationSnapshots[0]!;
		expect(plan.entryProjections).toHaveLength(1);
		expect(plan.entryProjections[0]!.fields.map((field) => field.field)).toEqual([0, 1]);
		for (const field of plan.entryProjections[0]!.fields)
			expect(plan.claimedIps).toContain(field.ip);
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(image);
	});

	it.each([
		"const pair=entries[index];return pair;",
		"const pair=entries[index];observe(pair);return pair[0];",
		"const pair=entries[index];pair[1]=7;return pair[0];",
		"const pair=entries[index];return [pair[0],pair===entries[0]];",
		"const pair=entries[index];entries[17];return pair[0];",
		"const pair=entries[index];return pair[index];",
		"let previous;for(let i=0;i<2;i++){const pair=entries[i];if(previous)observe(previous[0]);previous=pair;}return previous[0];",
		"let previous;for(let i=0;i<2;i++){const current=Object.entries(record);const pair=current[i];if(previous)observe(previous[0]);previous=pair;}return previous[0];",
		"const pair=entries[index];try{observe();}catch(error){return pair[0];}return pair[1];",
	])("materializes observed pairs and overlapping lifetimes: %s", (body) => {
		const fn = inspect(
			compile(`const entries=Object.entries(record);observe(record);${body}`),
		);
		expect(
			fn.storage!.objectEnumerationSnapshots.flatMap((plan) => plan.entryProjections),
		).toEqual([]);
	});

	it("rejects forged pair fields and missing projection claims", () => {
		const image = compile(
			"const entries=Object.entries(record);observe();const pair=entries[0];return [pair[0],pair[1]];",
		);
		const fn = inspect(image),
			plan = fn.storage!.objectEnumerationSnapshots[0]!,
			projection = plan.entryProjections[0]!;
		for (const forged of [
			{
				...plan,
				entryProjections: [{ ...projection, elementIp: plan.callIp }],
			},
			{
				...plan,
				entryProjections: [
					{
						...projection,
						fields: [{ ...projection.fields[0]!, field: 1 as const }],
					},
				],
			},
			{
				...plan,
				claimedIps: plan.claimedIps.filter((ip) => ip !== projection.fields[0]!.ip),
			},
		])
			expect(() =>
				serializeCompilerArtifact({
					...image,
					native: {
						...image.native,
						functions: image.native.functions.with(image.native.functions.indexOf(fn), {
							...fn,
							storage: {
								...fn.storage!,
								objectEnumerationSnapshots: [forged],
							},
						}),
					},
				}),
			).toThrow(/invalid or stale storage plan/);
	});

	it.each(["index", "0", "99"])(
		"keeps the sole immediate %s projection with each guarded producer",
		(index) => {
			const image = compile(`return Object.entries(record)[${index}];`);
			const fn = inspect(image);
			const plans = fn.storage!.objectEnumerationSnapshots;
			expect(plans).toHaveLength(2);
			expect(
				new Set(plans.map((plan) => fn.body.instructions[plan.callIp]!.opcode)),
			).toEqual(new Set(["CALL", "CALL_KNOWN"]));
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
				image,
			);
		},
	);

	it("retains snapshots when guarded loop inputs materialize from stack objects", () => {
		const image = compile(`
   let total = 0;
   for (let i = 0; i < 32; i++) {
    const index = i & 1;
    const row = {first: i, second: i & 255, third: 3, fourth: 4};
    const pair = Object.entries(row)[index];
    total += pair[0].length + pair[1];
   }
   return total;
  `);
		const fn = inspect(image);
		const snapshots = fn.storage!.objectEnumerationSnapshots;
		expect(snapshots).toHaveLength(2);
		for (const plan of snapshots) {
			expect(plan.entryProjections).toHaveLength(1);
			expect(plan.entryProjections[0]!.fields.map((field) => field.field)).toEqual([
				0, 1,
			]);
		}
		const observations = fn.specializations.flatMap((region) =>
			region.kind === "stack-object-plan"
				? region.sites.flatMap((site) =>
						site.materializations
							.filter((entry) => entry.kind === "observe")
							.map((entry) => entry.ip),
					)
				: [],
		);
		for (const plan of snapshots) expect(observations).toContain(plan.callIp);
	});

	it.each(["pair[0].length+pair[1]", "index+pair[0].length+pair[1]"])(
		"projects inlined wrapper fields through %s",
		(expression) => {
			const image = compile(`
   function project(record,index){return Object.entries(record)[index];}
   const pair=project(record,index);
   return ${expression};
  `);
			const plans = inspect(image).storage!.objectEnumerationSnapshots;
			expect(plans).toHaveLength(2);
			for (const plan of plans) expect(plan.entryProjections).toHaveLength(1);
		},
	);

	it.each([
		"observe(pair);return pair[0].length+pair[1];",
		"pair[1]=7;return pair[0];",
		"return [pair,pair[0]];",
		"try{observe();}catch(error){return pair[0];}return pair[1];",
		"const value=pair[1];observe(value);return pair[0];",
	])("retains joined pair materialization for %s", (body) => {
		const image = compile(`
   function project(record,index){return Object.entries(record)[index];}
   const pair=project(record,index);${body}
  `);
		const plans = inspect(image).storage!.objectEnumerationSnapshots;
		for (const plan of plans) expect(plan.entryProjections).toEqual([]);
	});

	it("retains materialization when join discovery exhausts its parameter budget", () => {
		const parameters = Array.from({ length: 257 }, (_, index) => `arg${index}`);
		const source = `globalThis.inspect=function inspect(${parameters.join()}){
   function project(record,index){return Object.entries(record)[index];}
   const pair=project(arg0,arg1);
   return pair[0].length+pair[1]+${parameters.slice(2).join("+")};
  };`;
		const image = lowerNativeStorage(
			compileSemanticProgramToProgramImage(
				analyzeSourceAndRunSemanticAnalysis(source, "entries.js"),
				{
					facts: compilerProgramFactsFromConfig(
						resolveBuildConfig({ engine: { primordials: "mutable" } }),
					),
				},
			),
			"precise",
		);
		const plans = inspect(image).storage!.objectEnumerationSnapshots;
		expect(plans).toHaveLength(2);
		for (const plan of plans) expect(plan.entryProjections).toEqual([]);
	});

	// Each case compiles the whole native fixture with the Node surface, which takes
	// seconds on a loaded CI runner and outgrew the default budget.
	it.each(["mutable", "locked"] as const)(
		"admits bundled count, pair and materializing observations under %s primordials",
		(primordials) => {
			const config = resolveBuildConfig({
				engine: { primordials, eval: false, realms: false },
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
		30_000,
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
