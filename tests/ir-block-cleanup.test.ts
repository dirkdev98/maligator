import { expect, test } from "vitest";
import { irOptTestHooks } from "../src/ir-opt.ts";
import type { IRFunction, IRInstruction } from "../src/ir.ts";

function fakeFunction(
	blocks: Array<Array<IRInstruction>>,
	bodyEntryBlock?: number,
): IRFunction {
	return {
		blocks: blocks.map((instructions) => ({ instructions })),
		bodyEntryBlock,
	} as unknown as IRFunction;
}

test("unreferenced block peeling cascades while retaining entry and orphan cycles", () => {
	const fn = fakeFunction(
		[
			[{ type: "jump", blocks: [5] }],
			[{ type: "tryBegin", blocks: [2, 2] }],
			[{ type: "jump", blocks: [4] }],
			[{ type: "jump", blocks: [3] }],
			[{ type: "jump", blocks: [5] }],
			[{ type: "return", registers: [-1] }],
		],
		5,
	);

	expect(irOptTestHooks.dropUnreferencedBlocksInFunction(fn)).toBe(true);
	expect(fn.blocks).toHaveLength(3);
	expect(fn.blocks[0]!.instructions).toEqual([{ type: "jump", blocks: [2] }]);
	expect(fn.blocks[1]!.instructions).toEqual([{ type: "jump", blocks: [1] }]);
	expect(fn.bodyEntryBlock).toBe(2);
});

test("unreferenced block peeling retains positional fall-through successors", () => {
	const fn = fakeFunction([
		[{ type: "createNumber", registers: [0], value: 1 }],
		[{ type: "return", registers: [0] }],
		[{ type: "createBoolean", registers: [1], value: true }],
		[{ type: "return", registers: [1] }],
	]);

	expect(irOptTestHooks.dropUnreferencedBlocksInFunction(fn)).toBe(true);
	expect(fn.blocks).toHaveLength(2);
	expect(fn.blocks[0]!.instructions[0]!.type).toBe("createNumber");
	expect(fn.blocks[1]!.instructions[0]!.type).toBe("return");
});

test("linear block chains rebuild once and patch every tryBegin target", () => {
	const fn = fakeFunction(
		[
			[
				{ type: "createNumber", registers: [0], value: 1 },
				{ type: "jump", blocks: [1] },
			],
			[
				{ type: "createBoolean", registers: [1], value: true },
				{ type: "jump", blocks: [2] },
			],
			[
				{ type: "tryBegin", blocks: [3, 4] },
				{ type: "jump", blocks: [3] },
			],
			[{ type: "return", registers: [-1] }],
			[{ type: "throw", registers: [2] }],
		],
		2,
	);

	expect(irOptTestHooks.combineLinearBlocksInFunction(fn)).toBe(true);
	expect(fn.blocks).toHaveLength(3);
	expect(fn.blocks[0]!.instructions.map((instruction) => instruction.type)).toEqual([
		"createNumber",
		"createBoolean",
		"tryBegin",
		"jump",
	]);
	expect(fn.blocks[0]!.instructions[2]).toEqual({ type: "tryBegin", blocks: [1, 2] });
	expect(fn.blocks[0]!.instructions[3]).toEqual({ type: "jump", blocks: [1] });
	expect(fn.bodyEntryBlock).toBe(0);
});

test("backedges and repeated target occurrences prevent linear merges", () => {
	const fn = fakeFunction([
		[
			{ type: "tryBegin", blocks: [1, 2] },
			{ type: "jump", blocks: [1] },
		],
		[{ type: "return", registers: [-1] }],
		[{ type: "jump", blocks: [1] }],
	]);

	expect(irOptTestHooks.combineLinearBlocksInFunction(fn)).toBe(false);
	expect(fn.blocks).toHaveLength(3);
});
