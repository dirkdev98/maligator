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
		expect(plan?.kind).toBe("fixed-f64");
		if (plan?.kind !== "fixed-f64") throw new Error("Missing storage region");
		expect(plan.views.map((view) => view.writable)).toEqual([false, false, true]);
		expect(plan.carried).toContain(plan.index);
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(image);
		expect(emitCompiledFunction(native, 1, "", false)).not.toBeNull();
	});
	it.each([
		"for(let i=0;i<count;i++){output[i]=left[i]+right[i];hook();}",
		"for(let i=0;i<count;i+=2){output[i]=left[i]+right[i];}",
		"for(let i=0;i<count;i++){output[i+1]=left[i]+right[i];}",
		"for(let i=0;i<count;i++){output[i]=left[i]+right[i];left=right;}",
		"for(let i=0;i<count;){output[i]=left[i]+right[i];if(hook)i++;}",
	])("declines an unproved interior: %s", (source) => {
		expect(
			compile(source).native.functions[1]!.storage!.numericLoopRegions.filter(
				(plan) => plan.kind === "fixed-f64",
			),
		).toEqual([]);
	});
	it("recomputes forged bounds, ownership, and write requirements", () => {
		const image = compile(body),
			native = image.native.functions[1]!;
		const plan = native.storage!.numericLoopRegions[0]!;
		if (plan.kind !== "fixed-f64") throw new Error("Missing storage region");
		for (const forged of [
			{ ...plan, bound: plan.index },
			{ ...plan, views: plan.views.slice(1) },
			{ ...plan, views: plan.views.map((view) => ({ ...view, writable: false })) },
			{ ...plan, kind: "integer" as const },
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
