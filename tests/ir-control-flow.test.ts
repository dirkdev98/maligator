import { expect, test } from "vitest";
import {
	buildIRExceptionHandlers,
	buildIROrdinaryControlFlow,
	irBlockCanReach,
} from "../src/ir-control-flow.ts";
import type { IRFunction, IRInstruction } from "../src/ir.ts";

function fakeFunction(blocks: Array<Array<IRInstruction>>): IRFunction {
	return {
		blocks: blocks.map((instructions) => ({ instructions })),
	} as unknown as IRFunction;
}

test("derives nested exception scopes in final IR instruction order", () => {
	const fn = fakeFunction([
		[
			{ type: "createNumber", registers: [0], value: 1 },
			{ type: "tryBegin", blocks: [1, 3] },
			{ type: "call", registers: [1, 2, 3] },
			{ type: "tryBegin", blocks: [2, 3] },
			{ type: "loadProperty", registers: [4, 1, 0] },
			{ type: "tryEnd" },
			{ type: "storeProperty", registers: [1, 0, 4] },
			{ type: "tryEnd" },
			{ type: "return", registers: [1] },
		],
		[{ type: "catch", registers: [5] }],
		[{ type: "catch", registers: [6] }],
		[],
	]);

	expect(buildIRExceptionHandlers(fn)).toEqual([
		[null, null, 1, null, 2, null, 1, null, null],
		[null],
		[null],
		[],
	]);
});

test("rejects malformed final IR exception scopes", () => {
	expect(() => buildIRExceptionHandlers(fakeFunction([[{ type: "tryEnd" }]]))).toThrow(
		/Unbalanced tryEnd/,
	);
	expect(() =>
		buildIRExceptionHandlers(fakeFunction([[{ type: "tryBegin", blocks: [4, 0] }]])),
	).toThrow(/Unknown handler target block 4/);
});

test("shares natural-loop, dominance, and reachability facts", () => {
	const fn = fakeFunction([
		[{ type: "jump", blocks: [1] }],
		[
			{ type: "jumpIf", blocks: [2], registers: [0] },
			{ type: "jump", blocks: [3] },
		],
		[{ type: "jump", blocks: [1] }],
		[{ type: "return", registers: [0] }],
	]);
	const cfg = buildIROrdinaryControlFlow(fn);

	expect(cfg.loops).toHaveLength(1);
	expect(cfg.loops[0]).toMatchObject({ header: 1, backedge: 2 });
	expect(cfg.loops[0]!.blocks).toEqual(new Set([1, 2]));
	expect(cfg.dominates(1, 2)).toBe(true);
	expect(irBlockCanReach(cfg, 0, 2)).toBe(true);
	expect(irBlockCanReach(cfg, 0, 2, new Set([1]))).toBe(false);
	expect(irBlockCanReach(cfg, 3, 1)).toBe(false);
});
