import { deepStrictEqual } from "node:assert";
import { describe, it } from "vitest";
import type { CompilerInstruction } from "../src/compiler/shared/compiler-instruction.ts";
import type {
	ExecutionFunction,
	ExecutionSafepointRoots,
} from "../src/compiler/target/execution-ir.ts";
import { executionSafepointRoots } from "../src/compiler/target/execution-liveness.ts";

interface Operation {
	type: string;
	registers: Array<number>;
	blocks: Array<number>;
}

const op = (type: string, registers: Array<number> = [], blocks: Array<number> = []) => ({
	type,
	registers,
	blocks,
});

function reference(
	blocks: Array<Array<Operation>>,
	representations: Array<string>,
	safepoints: Set<Operation>,
): Map<Operation, ExecutionSafepointRoots> {
	const rooted = (register: number) =>
		register >= 0 && ["boxed", "string"].includes(representations[register]!);
	const operands = (operation: Operation) => {
		const writes = ["move", "catch", "createUndefined"].includes(operation.type) ? 1 : 0;
		return {
			reads: operation.registers.slice(writes).filter(rooted),
			writes: operation.registers.slice(0, writes).filter(rooted),
		};
	};
	const successors = blocks.map((instructions, block) => {
		const result = new Set<number>();
		for (const instruction of instructions) {
			if (["jump", "jumpIf", "tryBegin"].includes(instruction.type)) {
				result.add(instruction.blocks[0]!);
			}
		}
		const last = instructions.findLast(
			(instruction) => !["sourcePos", "rootUse", "tryEnd"].includes(instruction.type),
		);
		if (
			(!last || !["jump", "return", "throw"].includes(last.type)) &&
			block + 1 < blocks.length
		) {
			result.add(block + 1);
		}
		return result;
	});
	const liveIn = blocks.map(() => new Set<number>());
	const liveOut = (block: number) => {
		const result = new Set<number>();
		for (const successor of successors[block]!) {
			for (const register of liveIn[successor]!) result.add(register);
		}
		return result;
	};
	let changed = true;
	while (changed) {
		changed = false;
		for (let block = blocks.length - 1; block >= 0; block--) {
			const live = liveOut(block);
			for (const instruction of blocks[block]!.toReversed()) {
				const { reads, writes } = operands(instruction);
				for (const register of writes) live.delete(register);
				for (const register of reads) live.add(register);
			}
			if (
				live.size !== liveIn[block]!.size ||
				[...live].some((register) => !liveIn[block]!.has(register))
			) {
				liveIn[block] = live;
				changed = true;
			}
		}
	}
	const result = new Map<Operation, ExecutionSafepointRoots>();
	for (let block = 0; block < blocks.length; block++) {
		const live = liveOut(block);
		for (const instruction of blocks[block]!.toReversed()) {
			const { reads, writes } = operands(instruction);
			if (safepoints.has(instruction)) {
				result.set(instruction, {
					rootRegisters: [...new Set([...live, ...reads, ...writes])].sort(
						(a, b) => a - b,
					),
					incomingRootRegisters: [
						...new Set(
							[...live].filter((register) => !writes.includes(register)).concat(reads),
						),
					].sort((a, b) => a - b),
					outgoingRootRegisters: [...new Set([...live, ...writes])].sort((a, b) => a - b),
				});
			}
			for (const register of writes) live.delete(register);
			for (const register of reads) live.add(register);
		}
	}
	return result;
}

function check(blocks: Array<Array<Operation>>, representations: Array<string>): void {
	const safepoints = new Set(blocks.flat());
	const fn = {
		registerCount: representations.length,
		registerRepresentations: representations,
		blocks: blocks.map((instructions) => ({ instructions })),
	} as unknown as ExecutionFunction;
	const actual = executionSafepointRoots(
		fn,
		safepoints as unknown as Set<CompilerInstruction>,
	);
	deepStrictEqual(actual, reference(blocks, representations, safepoints));
}

describe("Execution liveness block-transfer summaries", () => {
	it("preserves reads, read/modify/write and call-return result roots", () => {
		check(
			[
				[
					op("rootUse", [31, 32]),
					op("move", [31, 32]),
					op("move", [32, 32]),
					op("jump", [], [1]),
				],
				[op("catch", [32]), op("return", [31])],
			],
			new Array<string>(65).fill("boxed"),
		);
	});

	it("preserves handlers, disconnected cycles, holes and unboxed operands", () => {
		check(
			[
				[op("tryBegin", [], [2]), op("move", [0, 1]), op("jump", [], [1])],
				[op("return", [0]), op("tryEnd")],
				[op("catch", [0]), op("return", [1])],
				[op("rootUse", [-1, 2, 3]), op("jump", [], [3])],
			],
			["boxed", "string", "f64", "i32"],
		);
		check([[], []], []);
	});

	it("matches an independent set-based solver on 400 deterministic graphs", () => {
		let seed = 711;
		const random = (limit: number) => {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
			return seed % limit;
		};
		for (let trial = 0; trial < 400; trial++) {
			const registerCount = 1 + random(97);
			const blockCount = 1 + random(9);
			const representations = Array.from(
				{ length: registerCount },
				() => ["boxed", "string", "f64", "i32"][random(4)]!,
			);
			const blocks = Array.from({ length: blockCount }, () => {
				const instructions: Array<Operation> = [];
				for (let index = 0, count = random(12); index < count; index++) {
					instructions.push(
						random(2) === 0
							? op("move", [random(registerCount), random(registerCount)])
							: op("rootUse", [random(registerCount), -1]),
					);
				}
				if (random(3) === 0) instructions.push(op("tryBegin", [], [random(blockCount)]));
				instructions.push(
					random(3) === 0
						? op("return", [random(registerCount)])
						: op("jump", [], [random(blockCount)]),
				);
				return instructions;
			});
			check(blocks, representations);
		}
	});
});
