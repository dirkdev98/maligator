import { expect, test } from "vitest";
import { compileSemanticProgramToVmDefinition } from "../src/compile-core.ts";
import type { VmInstruction } from "../src/lower-vm.ts";
import { parseScript } from "../src/parser.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/semantic-analysis.ts";

function generatorYields(source: string): Array<VmInstruction["opcode"]> {
	const semantic = analyzeSourceAndRunSemanticAnalysis(
		source,
		"terminal-yield.js",
		parseScript(source, { strict: true }),
	);
	const definition = compileSemanticProgramToVmDefinition(semantic);
	const generator = definition.functions.find((fn) => fn.isGenerator)!;
	return generator.instructions
		.map((instruction) => instruction.opcode)
		.filter((opcode) => opcode === "YIELD" || opcode === "TERMINAL_YIELD");
}

function generatorOpcodes(source: string): Array<VmInstruction["opcode"]> {
	const semantic = analyzeSourceAndRunSemanticAnalysis(
		source,
		"generator-prologue.js",
		parseScript(source, { strict: true }),
	);
	const definition = compileSemanticProgramToVmDefinition(semantic);
	return definition.functions
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
