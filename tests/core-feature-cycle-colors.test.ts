import { equal } from "node:assert";
import { describe, it } from "vitest";
import {
	CORE_FUNCTION_HAS_BACKEDGES,
	scanCoreFunctionFeatures,
} from "../src/compiler/core/core-function-features.ts";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import type { CoreFunctionStore } from "../src/compiler/core/core-store.ts";

interface Block {
	live: boolean;
	edges: Array<number>;
	handler?: number;
}

function featureCycle(blocks: Array<Block>): boolean {
	const starts: Array<number> = [];
	const edges: Array<number> = [];
	for (const block of blocks) {
		starts.push(edges.length);
		edges.push(...block.edges);
	}
	const fn = {
		registry: coreOpcodeRegistry,
		blockCapacity: blocks.length,
		isBlockLive: (block: number) => blocks[block]?.live === true,
		blockTerminator: (block: number) => block,
		instructionKind: () => "return",
		kernel: {
			blockLive: (block: number) => (blocks[block]!.live ? 1 : 0),
			blockHandlerBlock: (block: number) => blocks[block]!.handler,
			terminatorEdgeStart: (block: number) => starts[block],
			terminatorEdgeCount: (block: number) => blocks[block]!.edges.length,
			terminatorEdgeBlock: (edge: number) => edges[edge],
			terminatorEdgeArgumentCount: () => 0,
			blockFirstInstruction: () => -1,
		},
	} as unknown as CoreFunctionStore;
	return (scanCoreFunctionFeatures(fn) & CORE_FUNCTION_HAS_BACKEDGES) !== 0;
}

function kahnCycle(blocks: Array<Block>): boolean {
	const successors = blocks.map((block) =>
		[...block.edges, ...(block.handler === undefined ? [] : [block.handler])].filter(
			(target) => blocks[target]?.live,
		),
	);
	const indegrees = new Array<number>(blocks.length).fill(0);
	let live = 0;
	for (let block = 0; block < blocks.length; block++) {
		if (!blocks[block]!.live) continue;
		live++;
		for (const target of successors[block]!) indegrees[target]!++;
	}
	const queue = blocks.flatMap((block, index) =>
		block.live && indegrees[index] === 0 ? [index] : [],
	);
	for (let cursor = 0; cursor < queue.length; cursor++) {
		for (const target of successors[queue[cursor]!]!) {
			if (--indegrees[target]! === 0) queue.push(target);
		}
	}
	return queue.length !== live;
}

describe("Dense feature-cycle colors", () => {
	it("distinguishes descending edges from disconnected control cycles", () => {
		equal(featureCycle([]), false);
		equal(
			featureCycle([
				{ live: true, edges: [] },
				{ live: true, edges: [0] },
			]),
			false,
		);
		equal(
			featureCycle([
				{ live: true, edges: [] },
				{ live: false, edges: [1] },
				{ live: true, edges: [3] },
				{ live: true, edges: [2] },
			]),
			true,
		);
	});

	it("includes handler cycles but ignores dead targets", () => {
		equal(featureCycle([{ live: true, edges: [], handler: 0 }]), true);
		equal(
			featureCycle([
				{ live: true, edges: [1] },
				{ live: false, edges: [0] },
			]),
			false,
		);
	});

	it("matches topological elimination across 1000 deterministic graphs", () => {
		let seed = 734;
		const random = (limit: number) => {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
			return seed % limit;
		};
		for (let trial = 0; trial < 1000; trial++) {
			const count = 1 + random(30);
			const blocks: Array<Block> = Array.from({ length: count }, () => ({
				live: random(5) !== 0,
				edges: Array.from({ length: random(4) }, () => random(count)),
				...(random(4) === 0 ? { handler: random(count) } : {}),
			}));
			equal(featureCycle(blocks), kahnCycle(blocks));
		}
	});
});
