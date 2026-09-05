import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { parseScript } from "../src/compiler/frontend/parser.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { optimizeSemanticProgramToCore } from "../src/compiler/pipeline/compile-core-common.ts";
import { compilerProgramFactsFromConfig } from "../src/compiler/shared/compiler-facts.ts";
import { lowerCoreCompilationToExecution } from "../src/compiler/target/lower-native-execution.ts";
import { lowerExecutionToProgramImage } from "../src/compiler/target/lower-native-program-image.ts";
import {
	deserializeRuntimeImage,
	serializeRuntimeImage,
} from "../src/compiler/target/program-image-codec.ts";

function compile(body: string) {
	const source = `globalThis.forward = ${body};`;
	const semantic = analyzeSourceAndRunSemanticAnalysis(
		source,
		"rest-forwarding.js",
		parseScript(source, { strict: false }),
	);
	const compilation = optimizeSemanticProgramToCore(
		semantic,
		{
			facts: compilerProgramFactsFromConfig(
				resolveBuildConfig({ engine: { primordials: "mutable" } }),
			),
		},
		(_phase, run) => run(),
	);
	return lowerExecutionToProgramImage(lowerCoreCompilationToExecution(compilation));
}

describe("rest forwarding allocation contract", () => {
	for (const source of [
		"function forward(...args) { return target(...args); }",
		"function forward(fn, ...args) { return fn(...args); }",
		"function forward(...args) { return target.apply(this, args); }",
		"function forward(fn, receiver, ...args) { return fn.apply(receiver, args); }",
	]) {
		it(`replaces the rest allocation for ${source}`, () => {
			const image = compile(source);
			const instructions = image.runtime.functions.flatMap((fn) => fn.instructions);
			expect(instructions.some((i) => i.opcode === "CALL_REST_ARGUMENTS")).toBe(true);
			expect(instructions.some((i) => i.opcode === "CREATE_REST_ARGUMENTS")).toBe(false);
			const owner = image.runtime.functions.find((fn) =>
				fn.instructions.some((i) => i.opcode === "CALL_REST_ARGUMENTS"),
			)!;
			expect(owner.needsArguments).toBe(true);
			const restored = deserializeRuntimeImage(serializeRuntimeImage(image.runtime));
			expect(
				restored.functions
					.flatMap((fn) => fn.instructions)
					.filter((i) => i.opcode === "CALL_REST_ARGUMENTS"),
			).toEqual(instructions.filter((i) => i.opcode === "CALL_REST_ARGUMENTS"));
		});
	}
	for (const source of [
		"function forward(...args) { args[0] = 7; return target(...args); }",
		"function forward(...args) { globalThis.saved = args; return target(...args); }",
		"function forward(...args) { return args; }",
		"function forward(...args) { return sink(null, args); }",
		"function forward(...args) { return () => target(...args); }",
		"function* forward(...args) { yield 1; return target(...args); }",
		"async function forward(...args) { await 1; return target(...args); }",
		"function forward(first, ...rest) { return target(first, ...rest); }",
		"function forward(...args) { let result; for (let i = 0; i < 2; i++) result = target(...args); return result; }",
		'function forward(...args) { eval("args[0] = 7"); return target(...args); }',
	]) {
		it(`retains ordinary array construction for ${source}`, () => {
			const image = compile(source);
			const instructions = image.runtime.functions.flatMap((fn) => fn.instructions);
			expect(instructions.some((i) => i.opcode === "CREATE_REST_ARGUMENTS")).toBe(true);
			expect(instructions.some((i) => i.opcode === "CALL_REST_ARGUMENTS")).toBe(false);
		});
	}
});
