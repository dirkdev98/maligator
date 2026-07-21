import { expect, test } from "vitest";
import { buildIRRegisterIndex, destinationCount } from "../src/ir-register-index.ts";
import type { IRFunction, IRInstruction } from "../src/ir.ts";

function fakeFunction(blocks: Array<Array<IRInstruction>>): IRFunction {
	return {
		blocks: blocks.map((instructions) => ({ instructions })),
	} as unknown as IRFunction;
}

test("indexes every destination and use position while ignoring sentinels", () => {
	const iterator: IRInstruction = {
		type: "iteratorStep",
		registers: [1, 2, 3, -1],
	};
	const awaitInstruction: IRInstruction = { type: "await", registers: [4, 5, 1] };
	const call: IRInstruction = { type: "call", registers: [-1, 4, 2, -1] };
	const fn = fakeFunction([[iterator, awaitInstruction], [call]]);
	const index = buildIRRegisterIndex(fn, { locations: true });

	expect(destinationCount(iterator)).toBe(2);
	expect(destinationCount(awaitInstruction)).toBe(2);
	expect(index.uniqueDefinitions.get(1)).toBe(iterator);
	expect(index.uniqueDefinitions.get(2)).toBe(iterator);
	expect(index.uniqueDefinitions.get(4)).toBe(awaitInstruction);
	expect(index.uniqueDefinitions.get(5)).toBe(awaitInstruction);
	expect(index.uses.get(1)).toEqual([{ instruction: awaitInstruction, position: 2 }]);
	expect(index.uses.get(2)).toEqual([{ instruction: call, position: 2 }]);
	expect(index.uses.has(-1)).toBe(false);
	expect(index.definitions.has(-1)).toBe(false);
	expect(index.locations?.get(call)).toEqual({ blockIndex: 1, instructionIndex: 0 });
});

test("excludes multiply-defined registers and snapshots require an explicit rebuild", () => {
	const first: IRInstruction = { type: "createNumber", registers: [0], value: 1 };
	const second: IRInstruction = { type: "createNumber", registers: [0], value: 2 };
	const use: IRInstruction = { type: "return", registers: [0] };
	const fn = fakeFunction([[first, use]]);
	const before = buildIRRegisterIndex(fn);

	expect(before.locations).toBeUndefined();
	expect(before.uniqueDefinitions.get(0)).toBe(first);
	fn.blocks[0]!.instructions.splice(1, 0, second);
	expect(before.definitions.get(0)).toHaveLength(1);

	const after = buildIRRegisterIndex(fn);
	expect(after.definitions.get(0)).toHaveLength(2);
	expect(after.uniqueDefinitions.has(0)).toBe(false);
	expect(after.uses.get(0)).toEqual([{ instruction: use, position: 0 }]);
});

test("classifies withExit as having no destination", () => {
	const withExit: IRInstruction = { type: "withExit", registers: [] };

	expect(destinationCount(withExit)).toBe(0);
});
