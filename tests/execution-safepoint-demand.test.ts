import { deepStrictEqual, equal } from "node:assert";
import { describe, it } from "vitest";
import type { CompilerInstruction } from "../src/compiler/shared/compiler-instruction.ts";
import type { ExecutionFunction } from "../src/compiler/target/execution-ir.ts";
import { executionSafepointRootRegisters } from "../src/compiler/target/execution-liveness.ts";

const op = (type: string, registers: Array<number> = [], blocks: Array<number> = []) =>
	({ type, registers, blocks }) as unknown as CompilerInstruction;
const fn = (blocks: Array<Array<CompilerInstruction>>) =>
	({
		registerCount: 3,
		registerRepresentations: ["boxed", "string", "f64"],
		blocks: blocks.map((instructions) => ({ instructions })),
	}) as unknown as ExecutionFunction;

describe("Demand-driven safepoint root reconstruction", () => {
	it("returns no roots for empty or foreign safepoint selections", () => {
		const current = fn([[op("return", [0])]]);
		equal(executionSafepointRootRegisters(current, new Set()).size, 0);
		equal(executionSafepointRootRegisters(current, new Set([op("return", [0])])).size, 0);
	});

	it("keeps liveness contributions from blocks without safepoints", () => {
		const point = op("move", [0, 0]);
		const current = fn([
			[point, op("jump", [], [1])],
			[op("rootUse", [1]), op("return", [0])],
		]);
		const roots = executionSafepointRootRegisters(current, new Set([point]));
		deepStrictEqual(roots.get(point), [0, 1]);
		equal(roots.size, 1);
	});

	it("matches filtering the full root map for each selected instruction", () => {
		const blocks = [
			[op("move", [0, 1]), op("move", [1, 0]), op("jump", [], [1])],
			[op("rootUse", [1]), op("move", [0, 0]), op("jump", [], [0])],
		];
		const current = fn(blocks);
		const all = executionSafepointRootRegisters(current, new Set(blocks.flat()));
		for (const point of blocks.flat()) {
			const selected = executionSafepointRootRegisters(current, new Set([point]));
			deepStrictEqual(selected.get(point), all.get(point));
			equal(selected.size, 1);
		}
	});
});
