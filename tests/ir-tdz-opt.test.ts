import { expect, test } from "vitest";
import { irOptTestHooks } from "../src/ir-opt.ts";
import type { IRFunction, IRInstruction } from "../src/ir.ts";

function fakeFunction(blocks: Array<Array<IRInstruction>>): IRFunction {
	return {
		blocks: blocks.map((instructions) => ({ instructions })),
	} as unknown as IRFunction;
}

test("TDZ optimization leaves functions without checks untouched", () => {
	const instructions: Array<IRInstruction> = [
		{ type: "createEmpty", registers: [0] },
		{ type: "storeLocal", registers: [0], index: 7 },
	];
	const fn = fakeFunction([instructions]);

	irOptTestHooks.eliminateRedundantTdzChecksInFunction(fn);
	expect(fn.blocks[0]!.instructions).toBe(instructions);
});

test("TDZ optimization removes a dominated local check but leaves non-local checks", () => {
	const fn = fakeFunction([
		[
			{ type: "createNumber", registers: [0], value: 1 },
			{ type: "storeLocal", registers: [0], index: 7 },
			{ type: "loadLocal", registers: [1], index: 7 },
			{ type: "throwIfTdz", registers: [1], nameStringIndex: 0 },
			{ type: "loadGlobal", registers: [2], index: 8 },
			{ type: "throwIfTdz", registers: [2], nameStringIndex: 1 },
			{ type: "loadCaptured", registers: [3], index: 9 },
			{ type: "throwIfTdz", registers: [3], nameStringIndex: 2 },
		],
	]);

	irOptTestHooks.eliminateRedundantTdzChecksInFunction(fn);
	expect(
		fn.blocks[0]!.instructions.filter((instruction) => instruction.type === "throwIfTdz"),
	).toEqual([
		{ type: "throwIfTdz", registers: [2], nameStringIndex: 1 },
		{ type: "throwIfTdz", registers: [3], nameStringIndex: 2 },
	]);
});

test("TDZ optimization preserves initialization across exception edges", () => {
	const fn = fakeFunction([
		[
			{ type: "createNumber", registers: [0], value: 1 },
			{ type: "storeLocal", registers: [0], index: 7 },
			{ type: "tryBegin", blocks: [2, 1] },
			{ type: "binary", registers: [3, 0, 0], operator: "+" },
			{ type: "jump", blocks: [1] },
		],
		[
			{ type: "tryEnd" },
			{ type: "loadLocal", registers: [1], index: 7 },
			{ type: "throwIfTdz", registers: [1], nameStringIndex: 0 },
		],
		[
			{ type: "loadLocal", registers: [2], index: 7 },
			{ type: "throwIfTdz", registers: [2], nameStringIndex: 0 },
		],
	]);

	irOptTestHooks.eliminateRedundantTdzChecksInFunction(fn);
	expect(fn.blocks[1]!.instructions).toEqual([
		{ type: "tryEnd" },
		{ type: "loadLocal", registers: [1], index: 7 },
	]);
	expect(fn.blocks[2]!.instructions).toEqual([
		{ type: "loadLocal", registers: [2], index: 7 },
	]);
});

test("TDZ optimization keeps a handler check when the protected range can throw first", () => {
	const fn = fakeFunction([
		[
			{ type: "tryBegin", blocks: [2, 1] },
			{ type: "binary", registers: [3, 0, 0], operator: "+" },
			{ type: "createNumber", registers: [0], value: 1 },
			{ type: "storeLocal", registers: [0], index: 7 },
			{ type: "jump", blocks: [1] },
		],
		[
			{ type: "tryEnd" },
			{ type: "loadLocal", registers: [1], index: 7 },
			{ type: "throwIfTdz", registers: [1], nameStringIndex: 0 },
		],
		[
			{ type: "loadLocal", registers: [2], index: 7 },
			{ type: "throwIfTdz", registers: [2], nameStringIndex: 0 },
		],
	]);

	irOptTestHooks.eliminateRedundantTdzChecksInFunction(fn);
	expect(fn.blocks[1]!.instructions).toEqual([
		{ type: "tryEnd" },
		{ type: "loadLocal", registers: [1], index: 7 },
	]);
	expect(fn.blocks[2]!.instructions).toEqual([
		{ type: "loadLocal", registers: [2], index: 7 },
		{ type: "throwIfTdz", registers: [2], nameStringIndex: 0 },
	]);
});

test("TDZ optimization leaves with-scoped functions unchanged", () => {
	const instructions: Array<IRInstruction> = [
		{ type: "createNumber", registers: [0], value: 1 },
		{ type: "storeLocal", registers: [0], index: 7 },
		{ type: "loadLocal", registers: [1], index: 7 },
		{ type: "throwIfTdz", registers: [1], nameStringIndex: 0 },
		{ type: "withEnter", registers: [2] },
	];
	const fn = fakeFunction([instructions]);

	irOptTestHooks.eliminateRedundantTdzChecksInFunction(fn);
	expect(fn.blocks[0]!.instructions).toEqual(instructions);
});
