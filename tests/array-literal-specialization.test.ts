import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { parseScript } from "../src/compiler/frontend/parser.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { optimizeSemanticProgramToCore } from "../src/compiler/pipeline/compile-core-common.ts";
import { compilerProgramFactsFromConfig } from "../src/compiler/shared/compiler-facts.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { lowerCoreCompilationToExecution } from "../src/compiler/target/lower-native-execution.ts";
import { lowerExecutionToProgramImage } from "../src/compiler/target/lower-native-program-image.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";

function compile(body: string) {
	const source = `globalThis.build = ${body};`;
	const semantic = analyzeSourceAndRunSemanticAnalysis(
		source,
		"array-literal-specialization.js",
		parseScript(source, { strict: false }),
	);
	const compilation = optimizeSemanticProgramToCore(
		semantic,
		{
			facts: compilerProgramFactsFromConfig(
				resolveBuildConfig({ engine: { primordials: "locked" } }),
			),
		},
		(_phase, run) => run(),
	);
	return deserializeCompilerArtifact(
		serializeCompilerArtifact(
			lowerExecutionToProgramImage(lowerCoreCompilationToExecution(compilation)),
		),
	);
}

function literalPlans(body: string) {
	const image = compile(body);
	const functionIndex = image.native.functions.findIndex((fn) =>
		fn.instructions.some((plan) => plan?.kind === "fresh-array-literal-element"),
	);
	expect(functionIndex).toBeGreaterThanOrEqual(0);
	const native = image.native.functions[functionIndex]!;
	return {
		image,
		functionIndex,
		native,
		plans: native.instructions.filter(
			(plan) => plan?.kind === "fresh-array-literal-element",
		),
	};
}

describe("fresh Array literal element definitions", () => {
	it("lowers dynamic packed literals to direct dense stores", () => {
		const { image, functionIndex, native, plans } = literalPlans(
			"function build(first, second, third, fourth) { return [first, second, third, fourth]; }",
		);
		expect(plans).toEqual(
			[0, 1, 2, 3].map((index) => ({ kind: "fresh-array-literal-element", index })),
		);
		const emitted = emitCompiledFunction(
			image.runtime.functions[functionIndex]!,
			native,
			functionIndex,
			"",
			false,
		);
		expect(emitted?.source.match(/mal_vm_op_define_fresh_array_element/g)).toHaveLength(
			4,
		);
	});

	it.each([
		"function build(first, third) { return [first, , third]; }",
		"function build(first, second) { return [first, second + 1]; }",
		"function build(first, effect) { return [first, effect()]; }",
		"function build(values) { return [...values]; }",
		"function build(first, second) { const values = []; values[0] = first; values[1] = second; return values; }",
	])("keeps non-literal initialization generic for %s", (body) => {
		const image = compile(body);
		expect(
			image.native.functions.some((fn) =>
				fn.instructions.some((plan) => plan?.kind === "fresh-array-literal-element"),
			),
		).toBe(false);
	});
});
