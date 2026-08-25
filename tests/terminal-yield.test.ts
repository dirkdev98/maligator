import { expect, test } from "vitest";
import { parseScript } from "../src/compiler/frontend/parser.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import type { BytecodeInstruction } from "../src/compiler/target/lower-vm.ts";

function generatorYields(source: string): Array<BytecodeInstruction["opcode"]> {
	const semantic = analyzeSourceAndRunSemanticAnalysis(
		source,
		"terminal-yield.js",
		parseScript(source, { strict: true }),
	);
	const definition = compileSemanticProgramToProgramImage(semantic);
	const generator = definition.runtime.functions.find((fn) => fn.isGenerator)!;
	return generator.instructions
		.map((instruction) => instruction.opcode)
		.filter((opcode) => opcode === "YIELD" || opcode === "TERMINAL_YIELD");
}

function generatorOpcodes(source: string): Array<BytecodeInstruction["opcode"]> {
	const semantic = analyzeSourceAndRunSemanticAnalysis(
		source,
		"generator-prologue.js",
		parseScript(source, { strict: true }),
	);
	const definition = compileSemanticProgramToProgramImage(semantic);
	return definition.runtime.functions
		.find((fn) => fn.isGenerator)!
		.instructions.map((instruction) => instruction.opcode);
}

test.each([
	"function* g() { yield 1; }",
	"function* g() { yield 1; return; }",
	"function* g() { const added = eval('(function () { return 1; })'); yield added(); }",
])("marks a synchronous tail yield terminal: %s", (source) => {
	expect(generatorYields(source)).toEqual(["TERMINAL_YIELD"]);
});

test.each([
	"function* g() { const sent = yield 1; return sent; }",
	"function* g() { yield 1; sideEffect(); }",
	"function* g() { return yield 1; }",
	"function* g() { try { yield 1; } finally { sideEffect(); } }",
	"function* g() { try { yield 1; } catch (error) { sideEffect(error); } }",
	"function* g() { yield* [1]; }",
	"async function* g() { yield 1; }",
])("keeps an observable continuation resumable: %s", (source) => {
	expect(generatorYields(source)).not.toContain("TERMINAL_YIELD");
});

test("uses only the async-generator coroutine prologue", () => {
	const opcodes = generatorOpcodes("async function* g() { yield 1; }");
	expect(opcodes.filter((opcode) => opcode === "GENERATOR_START")).toEqual([
		"GENERATOR_START",
	]);
	expect(opcodes).not.toContain("ASYNC_START");
});
