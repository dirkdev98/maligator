import { expect, test } from "vitest";
import { irOptTestHooks } from "../src/ir-opt.ts";
import type { IntermediateProgram, IRFunction, IRInstruction } from "../src/ir.ts";

function programWith(instructions: Array<IRInstruction>): IntermediateProgram {
	return {
		functions: [
			{
				blocks: [{ instructions }],
				parameterCount: 0,
			} as IRFunction,
		],
	} as IntermediateProgram;
}

test("removes ToNumeric from a proven Number", () => {
	const program = programWith([
		{ type: "createNumber", registers: [0], value: 1 },
		{ type: "unary", registers: [1, 0], operator: "tonumeric" },
	]);

	expect(irOptTestHooks.eliminateRedundantNumericCoercions(program)).toBe(true);
	expect(program.functions[0]!.blocks[0]!.instructions[1]).toEqual({
		type: "move",
		registers: [1, 0],
	});
});

test("forwards a single-use nonthrowing result but not a throwing binary result", () => {
	const numeric = programWith([
		{ type: "createNumber", registers: [0], value: 1 },
		{ type: "unary", registers: [1, 0], operator: "increment" },
		{ type: "move", registers: [0, 1] },
	]);
	expect(irOptTestHooks.forwardSingleUsePrimitiveResults(numeric)).toBe(true);
	expect(numeric.functions[0]!.blocks[0]!.instructions).toEqual([
		{ type: "createNumber", registers: [0], value: 1 },
		{ type: "unary", registers: [0, 0], operator: "increment" },
	]);

	const throwing = programWith([
		{ type: "createNumber", registers: [0], value: 1 },
		{ type: "binary", registers: [1, 0, 0], operator: "in" },
		{ type: "move", registers: [0, 1] },
	]);
	expect(irOptTestHooks.forwardSingleUsePrimitiveResults(throwing)).toBe(false);
});

test("value-numbers repeated pure predicates within a block", () => {
	const program = programWith([
		{ type: "createEmpty", registers: [0] },
		{ type: "isEmpty", registers: [1, 0] },
		{ type: "isEmpty", registers: [2, 0] },
	]);

	expect(irOptTestHooks.valueNumberIsEmptyChecks(program)).toBe(true);
	expect(program.functions[0]!.blocks[0]!.instructions[2]).toEqual({
		type: "move",
		registers: [2, 1],
	});
});

test("commons repeated primitive constants without conflating signed zero", () => {
	const program = programWith([
		{ type: "createNumber", registers: [0], value: 1 },
		{ type: "createNumber", registers: [1], value: 1 },
		{ type: "createNumber", registers: [2], value: -0 },
		{ type: "createNumber", registers: [3], value: 0 },
	]);

	expect(irOptTestHooks.commonPrimitiveConstants(program)).toBe(true);
	expect(program.functions[0]!.blocks[0]!.instructions).toEqual([
		{ type: "createNumber", registers: [0], value: 1 },
		{ type: "move", registers: [1, 0] },
		{ type: "createNumber", registers: [2], value: -0 },
		{ type: "createNumber", registers: [3], value: 0 },
	]);
});

test("value-numbers repeated subtraction only for proven Numbers", () => {
	const program = programWith([
		{ type: "createNumber", registers: [0], value: 4 },
		{ type: "createNumber", registers: [1], value: 1 },
		{ type: "binary", registers: [2, 0, 1], operator: "-" },
		{ type: "binary", registers: [3, 0, 1], operator: "-" },
	]);

	expect(irOptTestHooks.valueNumberNumericSubtractions(program)).toBe(true);
	expect(program.functions[0]!.blocks[0]!.instructions[3]).toEqual({
		type: "move",
		registers: [3, 2],
	});
});
