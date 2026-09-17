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

function compile(body: string, primordials: "locked" | "mutable" = "mutable") {
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
				resolveBuildConfig({ engine: { primordials } }),
			),
		},
		(_phase, run) => run(),
	);
	return lowerExecutionToProgramImage(lowerCoreCompilationToExecution(compilation));
}

describe("rest forwarding allocation contract", () => {
	it("scalarizes locked static element reads into argument snapshots", () => {
		const image = compile(
			"function read(first, ...rest) { return arguments[3] + rest[2] + rest[0] + rest[2]; }",
			"locked",
		);
		const owner = image.runtime.functions.find((fn) => fn.argumentSnapshotCount === 2);
		expect(owner).toBeDefined();
		const prefix = owner!.instructions.slice(0, owner!.argumentSnapshotCount);
		expect(prefix.every((instruction) => instruction.opcode === "LOAD_ARGUMENT")).toBe(
			true,
		);
		expect(
			new Set(
				prefix.flatMap((instruction) =>
					instruction.opcode === "LOAD_ARGUMENT" ? [instruction.index] : [],
				),
			),
		).toEqual(new Set([1, 3]));
		expect(owner!.instructions.some((i) => i.opcode === "CREATE_REST_ARGUMENTS")).toBe(
			false,
		);
	});

	for (const source of [
		"function read(first = fallback(), ...rest) { return rest[0]; }",
		"function read(first, ...rest) { first = 99; return rest[0]; }",
	]) {
		it(`scalarizes reads independently of parameter initialization for ${source}`, () => {
			const image = compile(source, "locked");
			const instructions = image.runtime.functions.flatMap((fn) => fn.instructions);
			expect(instructions.some((i) => i.opcode === "LOAD_ARGUMENT")).toBe(true);
			expect(instructions.some((i) => i.opcode === "CREATE_REST_ARGUMENTS")).toBe(false);
		});
	}

	for (const source of [
		"function read(index, ...rest) { return rest[index]; }",
		"function read(...rest) { return rest.length; }",
		"function read(...rest) { rest[0] = 1; return rest[0]; }",
		"function read(...rest) { globalThis.saved = rest; return rest[0]; }",
		"function read(...rest) { return () => rest[0]; }",
		"function read(first, ...rest) { return rest[2147483647]; }",
		"function* read(...rest) { yield rest[0]; }",
		"async function read(...rest) { return rest[0]; }",
	]) {
		it(`retains locked rest construction for ${source}`, () => {
			const image = compile(source, "locked");
			const instructions = image.runtime.functions.flatMap((fn) => fn.instructions);
			expect(instructions.some((i) => i.opcode === "CREATE_REST_ARGUMENTS")).toBe(true);
		});
	}

	it("retains mutable static element reads", () => {
		const image = compile("function read(...rest) { return rest[0]; }");
		const instructions = image.runtime.functions.flatMap((fn) => fn.instructions);
		expect(instructions.some((i) => i.opcode === "CREATE_REST_ARGUMENTS")).toBe(true);
	});

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
