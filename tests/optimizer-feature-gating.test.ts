import { expect, test } from "vitest";
import { executeIROptimizations, irOptTestHooks } from "../src/ir-opt.ts";
import { compileSemanticProgramToIr } from "../src/ir.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/semantic-analysis.ts";

function optimize(source: string) {
	const semantic = analyzeSourceAndRunSemanticAnalysis(
		source,
		"optimizer-gating-test.js",
	);
	const program = compileSemanticProgramToIr(semantic);
	irOptTestHooks.resetOptimizationIndexBuildCounts();
	executeIROptimizations(program);
	return program;
}

test("index-heavy passes skip functions without structural candidates", () => {
	optimize(`
		globalThis.a = (value) => value + 1;
		globalThis.b = (value) => value * 2;
		globalThis.c = (value) => value - 3;
	`);

	expect(irOptTestHooks.optimizationIndexBuildCounts()).toEqual({
		typeofComparisons: 0,
		capturedSlots: 0,
	});
});

test("candidate functions still fuse typeof comparisons", () => {
	const program = optimize(`
		globalThis.classify = (value) => typeof value === "number";
	`);
	const instructions = program.functions.flatMap((fn) =>
		fn.blocks.flatMap((block) => block.instructions),
	);

	expect(instructions.some((instruction) => instruction.type === "typeofCompare")).toBe(
		true,
	);
	expect(irOptTestHooks.optimizationIndexBuildCounts().typeofComparisons).toBeGreaterThan(
		0,
	);
});

test("candidate functions still internalize captured slots and remove their environment", () => {
	const program = optimize(`
		globalThis.read = function outer(captured) {
			const inner = () => captured;
			return inner();
		};
	`);
	const outer = program.functions.find((fn) => fn.functionIndex === 1)!;
	const instructions = program.functions.flatMap((fn) =>
		fn.blocks.flatMap((block) => block.instructions),
	);

	expect(
		instructions.some(
			(instruction) =>
				instruction.type === "loadCaptured" || instruction.type === "storeCaptured",
		),
	).toBe(false);
	expect(outer.nextCapturedIndex).toBe(0);
	expect(irOptTestHooks.optimizationIndexBuildCounts().capturedSlots).toBeGreaterThan(0);
});
