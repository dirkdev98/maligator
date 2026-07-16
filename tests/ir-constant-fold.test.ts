import { describe, expect, it } from "vitest";
import { cF64Literal } from "../src/emit-c.ts";
import { executeIROptimizations, irOptTestHooks } from "../src/ir-opt.ts";
import { compileSemanticProgramToIr } from "../src/ir.ts";
import type { IntermediateProgram, IRFunction, IRInstruction } from "../src/ir.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/semantic-analysis.ts";

function optimizedInstructions(source: string): Array<IRInstruction> {
	const semantic = analyzeSourceAndRunSemanticAnalysis(source, "constant-fold-test.js");
	const program = compileSemanticProgramToIr(semantic);
	executeIROptimizations(program);
	return program.functions.flatMap((fn) =>
		fn.blocks.flatMap((block) => block.instructions),
	);
}

describe("primitive constant folding", () => {
	it("folds numeric chains and removes a constant branch", () => {
		const instructions = optimizedInstructions(`
			function f(a) {
				const folded = (2 + 3) * 4;
				if ((7 % 3) === 1) return a + folded;
				return 99;
			}
			globalThis.keep = f;
		`);

		expect(
			instructions.some(
				(instruction) => instruction.type === "createF64" && instruction.value === 20,
			),
		).toBe(true);
		expect(
			instructions.some(
				(instruction) => instruction.type === "createNumber" && instruction.value === 99,
			),
		).toBe(false);
		expect(instructions.some((instruction) => instruction.type === "jumpIf")).toBe(false);
	});

	it("preserves NaN, infinities, and negative zero", () => {
		const instructions = optimizedInstructions(`
			function nan() { return 0 / 0; }
			function infinity() { return 1 / 0; }
			function negativeZero() { return -0; }
			globalThis.keep = [nan, infinity, negativeZero];
		`);
		const values = instructions
			.filter(
				(instruction): instruction is Extract<IRInstruction, { type: "createF64" }> =>
					instruction.type === "createF64",
			)
			.map((instruction) => instruction.value);

		expect(values.some(Number.isNaN)).toBe(true);
		expect(values).toContain(Number.POSITIVE_INFINITY);
		expect(values.some((value) => Object.is(value, -0))).toBe(true);
		expect(cF64Literal(-0)).toBe("-0.0");
	});

	it("follows primitive loose equality coercion", () => {
		const instructions = optimizedInstructions(`
			function f() {
				return false == 0 && true == 1 && null == undefined && false !== 0;
			}
			globalThis.keep = f;
		`);
		const booleans = instructions
			.filter(
				(instruction): instruction is Extract<IRInstruction, { type: "createBoolean" }> =>
					instruction.type === "createBoolean",
			)
			.map((instruction) => instruction.value);

		expect(booleans).toContain(true);
		expect(booleans).not.toContain(false);
	});

	it("does not propagate constants from multiply-defined registers", () => {
		const fn = {
			blocks: [
				[{ type: "jumpIf", registers: [0], blocks: [2] }],
				[
					{ type: "createNumber", registers: [2], value: 1 },
					{ type: "createNumber", registers: [3], value: 1 },
					{ type: "binary", registers: [1, 2, 3], operator: "+" },
					{ type: "jump", blocks: [3] },
				],
				[
					{ type: "createNumber", registers: [5], value: 2 },
					{ type: "createNumber", registers: [6], value: 2 },
					{ type: "binary", registers: [1, 5, 6], operator: "+" },
					{ type: "jump", blocks: [3] },
				],
				[
					{ type: "createNumber", registers: [7], value: 10 },
					{ type: "binary", registers: [4, 1, 7], operator: "+" },
					{ type: "return", registers: [4] },
				],
			].map((instructions) => ({ instructions })) as Array<IRFunction["blocks"][number]>,
		} as IRFunction;
		const program = { functions: [fn] } as IntermediateProgram;

		expect(irOptTestHooks.foldPrimitiveConstants(program)).toBe(true);
		expect(fn.blocks[3]!.instructions[1]!.type).toBe("binary");
	});

	it("leaves resumable functions for a resume-aware analysis", () => {
		const instructions = optimizedInstructions(`
			async function f() { return (2 + 3) * 4; }
			function* g() { yield (6 - 1) * 4; }
			globalThis.keep = [f, g];
		`);
		expect(
			instructions.filter((instruction) => instruction.type === "binary").length,
		).toBeGreaterThanOrEqual(4);
	});

	it("folds primitive coercions without folding object coercion", () => {
		const instructions = optimizedInstructions(`
			function f(object) {
				const a = +null;
				const b = ~false;
				const c = !undefined;
				return a + b + c + +object;
			}
			globalThis.keep = f;
		`);

		expect(
			instructions.some(
				(instruction) => instruction.type === "unary" && instruction.operator === "+",
			),
		).toBe(true);
		expect(
			instructions.some(
				(instruction) => instruction.type === "unary" && instruction.operator === "~",
			),
		).toBe(false);
		expect(
			instructions.some(
				(instruction) => instruction.type === "unary" && instruction.operator === "!",
			),
		).toBe(false);
	});
});
