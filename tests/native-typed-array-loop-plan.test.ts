import { describe, expect, it } from "vitest";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import {
	serializeCompilerArtifact,
	deserializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";

function compile(body: string) {
	return compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(
			`globalThis.kernel=function(left,right,output,count,hook){${body}};`,
			"/typed-loop.js",
		),
	);
}
const body = "for(let i=0;i<count;i++){output[i]=left[i]+right[i];}return output;";
describe("fixed TypedArray loop storage", () => {
	it("retains one range and three ordered view accesses through the artifact", () => {
		const image = compile(body),
			native = image.native.functions[1]!;
		const [plan] = native.storage!.numericLoopRegions;
		expect(plan?.kind).toBe("fixed-numeric");
		if (plan?.kind !== "fixed-numeric") throw new Error("Missing storage region");
		expect(plan.views.map((view) => view.writable)).toEqual([false, false, true]);
		expect(plan.carried).toContain(plan.index);
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(image);
		const emitted = emitCompiledFunction(native, 1, "", false)!.source;
		expect(emitted.match(/mal_vm_fixed_numeric_storage\(/g)).toHaveLength(
			plan.views.length,
		);
		expect(emitted.match(/mal_vm_fixed_numeric_load\(/g)).toHaveLength(2);
		expect(emitted.match(/mal_vm_fixed_numeric_store\(/g)).toHaveLength(1);
	});
	it("dispatches once to a bounded Float64 specialization before the loop", () => {
		const native = compile(body).native.functions[1]!;
		const [plan] = native.storage!.numericLoopRegions;
		if (plan?.kind !== "fixed-numeric") throw new Error("Missing storage region");
		const source = emitCompiledFunction(native, 1, "", false)!.source;
		const kindGuards = [...source.matchAll(/\.kind == MAL_TA_FLOAT64/g)];
		expect(kindGuards).toHaveLength(plan.views.length);
		expect(kindGuards.at(-1)!.index).toBeLessThan(source.indexOf("for (;;)"));
		expect(source.match(/for \(;;\)/g)).toHaveLength(2);
		expect(source.match(/mal_vm_fixed_numeric_storage\(/g)).toHaveLength(
			plan.views.length,
		);
		expect(
			source.match(
				/mal_scalar_f64_from_bits\(mal_scalar_load_native_u64\(__typed_loop_/g,
			),
		).toHaveLength(2);
		expect(source.match(/mal_scalar_store_native_u64\(__typed_loop_/g)).toHaveLength(1);
	});
	it("retains the store before a rounded or aliased readback", () => {
		const image = compile(
			"for(let i=0;i<count;i++){output[i]=left[i]+right[i];right[i]=output[i]-left[i];}return right;",
		);
		const native = image.native.functions[1]!;
		const [plan] = native.storage!.numericLoopRegions;
		if (plan?.kind !== "fixed-numeric") throw new Error("Missing storage region");
		expect(plan.views.map((view) => view.writable)).toEqual([false, true, true]);
		const accesses = plan.claimedIps
			.map((ip) => native.body.instructions[ip]!)
			.filter((op) => op.opcode === "LOAD_PROPERTY" || op.opcode === "STORE_PROPERTY");
		expect(accesses.map((op) => op.opcode)).toEqual([
			"LOAD_PROPERTY",
			"LOAD_PROPERTY",
			"STORE_PROPERTY",
			"LOAD_PROPERTY",
			"LOAD_PROPERTY",
			"STORE_PROPERTY",
		]);
		expect(
			[
				...emitCompiledFunction(native, 1, "", false)!.source.matchAll(
					/mal_vm_fixed_numeric_(load|store)\(/g,
				),
			].map((match) => match[1]),
		).toEqual(["load", "load", "store", "load", "load", "store"]);
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(image);
	});
	it.each([
		"for(let i=0;i<count;i++){output[i]=left[i]+right[i];hook();}",
		"for(let i=0;i<count;i+=2){output[i]=left[i]+right[i];}",
		"for(let i=0;i<count;i++){output[i+1]=left[i]+right[i];}",
		"for(let i=0;i<count;i++){output[i]=left[i]+right[i];left=right;}",
		"for(let i=0;i<count;){output[i]=left[i]+right[i];if(hook)i++;}",
		"for(let i=0;i<count;i++){output[i]=left[i]+right[i];count--;}",
		"for(let i=0;i<count;i++){output[i]=left[i]+right[i];output[i]=hook(i);}",
	])("declines an unproved interior: %s", (source) => {
		expect(
			compile(source).native.functions[1]!.storage!.numericLoopRegions.filter(
				(plan) => plan.kind === "fixed-numeric",
			),
		).toEqual([]);
	});
	it("recomputes forged bounds, ownership, and write requirements", () => {
		const image = compile(body),
			native = image.native.functions[1]!;
		const plan = native.storage!.numericLoopRegions[0]!;
		if (plan.kind !== "fixed-numeric") throw new Error("Missing storage region");
		for (const forged of [
			{ ...plan, bound: plan.index },
			{ ...plan, views: plan.views.slice(1) },
			{ ...plan, views: plan.views.map((view) => ({ ...view, writable: false })) },
			{ ...plan, kind: "integer" as const },
			{ ...plan, carried: plan.carried.filter((register) => register !== plan.index) },
		])
			expect(() =>
				serializeCompilerArtifact({
					...image,
					native: {
						...image.native,
						functions: image.native.functions.with(1, {
							...native,
							storage: { ...native.storage!, numericLoopRegions: [forged] },
						}),
					},
				}),
			).toThrow(/invalid or stale storage plan/);
	});
});
