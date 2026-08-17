import type { IRInstructionLocation } from "./ir-register-index.ts";
import type { IRFunction, IRInstruction } from "./ir.ts";

/** One reducible natural loop in the ordinary (non-exceptional) IR CFG. */
export interface IRNaturalLoop {
	readonly header: number;
	readonly backedge: number;
	readonly blocks: ReadonlySet<number>;
}

/**
 * Function-level ordinary control flow retained while IR block identity is
 * still available. Analyses whose candidates can throw must either reject
 * exception regions or add their exceptional edges separately.
 */
export interface IROrdinaryControlFlow {
	readonly successors: ReadonlyArray<ReadonlyArray<number>>;
	readonly predecessors: ReadonlyArray<ReadonlyArray<number>>;
	readonly reachable: ReadonlySet<number>;
	readonly loops: ReadonlyArray<IRNaturalLoop>;
	/** Whether `dominator` dominates `block`. */
	dominates(dominator: number, block: number): boolean;
}

/**
 * Innermost active exception handler at every final-IR instruction. Structural
 * markers themselves have no handler; a tryBegin takes effect after its marker
 * and a tryEnd stops protecting instructions after its marker.
 */
export type IRExceptionHandlers = ReadonlyArray<ReadonlyArray<number | null>>;

/**
 * Interpret exception markers once in the same block/instruction order used by
 * VM lowering. Consumers decide which protected instructions can actually throw.
 */
export function buildIRExceptionHandlers(fn: IRFunction): IRExceptionHandlers {
	const result: Array<Array<number | null>> = [];
	const activeHandlers: Array<number> = [];
	for (const block of fn.blocks) {
		const handlers = new Array<number | null>(block.instructions.length).fill(null);
		result.push(handlers);
		for (let index = 0; index < block.instructions.length; index++) {
			const instruction = block.instructions[index]!;
			if (instruction.type === "tryBegin") {
				const handler = instruction.blocks[0];
				if (handler < 0 || handler >= fn.blocks.length) {
					throw new Error(`Unknown handler target block ${handler}`);
				}
				activeHandlers.push(handler);
				continue;
			}
			if (instruction.type === "tryEnd") {
				if (activeHandlers.pop() === undefined) {
					throw new Error("Unbalanced tryEnd marker in IR control-flow analysis");
				}
				continue;
			}
			handlers[index] = activeHandlers.at(-1) ?? null;
		}
	}
	if (activeHandlers.length > 0) {
		throw new Error("Unbalanced tryBegin marker in IR control-flow analysis");
	}
	return result;
}

function predecessorLists(
	successors: ReadonlyArray<ReadonlyArray<number>>,
): Array<Array<number>> {
	const predecessors = Array.from(
		{ length: successors.length },
		() => new Array<number>(),
	);
	for (let block = 0; block < successors.length; block++) {
		for (const successor of successors[block]!) {
			if (successor >= 0 && successor < successors.length) {
				predecessors[successor]!.push(block);
			}
		}
	}
	return predecessors;
}

/** Cooper-Harvey-Kennedy immediate dominators in reverse-postorder. */
function immediateDominatorParents(successors: ReadonlyArray<ReadonlyArray<number>>): {
	parents: Int32Array;
	reachable: Set<number>;
} {
	const count = successors.length;
	const parents = new Int32Array(count);
	parents.fill(-1);
	if (count === 0) return { parents, reachable: new Set() };

	const predecessors = predecessorLists(successors);
	const visited = new Uint8Array(count);
	const postorder: Array<number> = [];
	const stack: Array<{ block: number; next: number }> = [{ block: 0, next: 0 }];
	visited[0] = 1;
	while (stack.length > 0) {
		const frame = stack[stack.length - 1]!;
		const targets = successors[frame.block]!;
		if (frame.next < targets.length) {
			const target = targets[frame.next++]!;
			if (target >= 0 && target < count && visited[target] === 0) {
				visited[target] = 1;
				stack.push({ block: target, next: 0 });
			}
			continue;
		}
		postorder.push(frame.block);
		stack.pop();
	}

	const reversePostorder = postorder.reverse();
	const reachable = new Set(reversePostorder);
	const rank = new Int32Array(count);
	rank.fill(-1);
	for (const [index, block] of reversePostorder.entries()) rank[block] = index;
	parents[0] = 0;
	const intersect = (leftInitial: number, rightInitial: number): number => {
		let left = leftInitial;
		let right = rightInitial;
		while (left !== right) {
			while (rank[left]! > rank[right]!) left = parents[left]!;
			while (rank[right]! > rank[left]!) right = parents[right]!;
		}
		return left;
	};
	let changed = true;
	while (changed) {
		changed = false;
		for (let index = 1; index < reversePostorder.length; index++) {
			const block = reversePostorder[index]!;
			const incoming = predecessors[block]!.filter(
				(predecessor) => parents[predecessor]! >= 0,
			);
			if (incoming.length === 0) continue;
			let parent = incoming[0]!;
			for (let incomingIndex = 1; incomingIndex < incoming.length; incomingIndex++) {
				parent = intersect(parent, incoming[incomingIndex]!);
			}
			if (parents[block] !== parent) {
				parents[block] = parent;
				changed = true;
			}
		}
	}
	return { parents, reachable };
}

/** Build the canonical ordinary CFG used by final IR region proofs. */
export function buildIROrdinaryControlFlow(fn: IRFunction): IROrdinaryControlFlow {
	const successors = fn.blocks.map((block, blockIndex): Array<number> => {
		const result = new Set<number>();
		for (const instruction of block.instructions) {
			if (instruction.type !== "jump" && instruction.type !== "jumpIf") continue;
			for (const target of instruction.blocks) {
				if (target >= 0 && target < fn.blocks.length) result.add(target);
			}
		}
		const last = block.instructions[block.instructions.length - 1];
		if (
			last?.type !== "jump" &&
			last?.type !== "return" &&
			last?.type !== "throw" &&
			blockIndex + 1 < fn.blocks.length
		) {
			result.add(blockIndex + 1);
		}
		return [...result];
	});
	const predecessors = predecessorLists(successors);
	const { parents, reachable } = immediateDominatorParents(successors);
	const dominates = (dominator: number, block: number): boolean => {
		if (!reachable.has(dominator) || !reachable.has(block)) return false;
		let current = block;
		for (let steps = 0; steps <= fn.blocks.length; steps++) {
			if (current === dominator) return true;
			const parent = parents[current]!;
			if (parent < 0 || parent === current) return false;
			current = parent;
		}
		return false;
	};

	const loops: Array<IRNaturalLoop> = [];
	for (const from of reachable) {
		for (const to of successors[from]!) {
			if (!dominates(to, from)) continue;
			const blocks = new Set<number>([to, from]);
			const work = from === to ? [] : [from];
			while (work.length > 0) {
				const current = work.pop()!;
				for (const predecessor of predecessors[current]!) {
					if (!reachable.has(predecessor) || blocks.has(predecessor)) continue;
					blocks.add(predecessor);
					if (predecessor !== to) work.push(predecessor);
				}
			}
			loops.push({ header: to, backedge: from, blocks });
		}
	}
	return { successors, predecessors, reachable, loops, dominates };
}

/** Whether one reachable ordinary block can reach another without blocked blocks. */
export function irBlockCanReach(
	cfg: IROrdinaryControlFlow,
	start: number,
	target: number,
	blocked: ReadonlySet<number> = new Set(),
): boolean {
	const pending = [start];
	const visited = new Set<number>();
	while (pending.length > 0) {
		const block = pending.pop()!;
		if (blocked.has(block) || visited.has(block) || !cfg.reachable.has(block)) continue;
		if (block === target) return true;
		visited.add(block);
		pending.push(...(cfg.successors[block] ?? []));
	}
	return false;
}

/** Instruction dominance using block dominance plus in-block source order. */
export function irInstructionDominates(
	cfg: IROrdinaryControlFlow,
	locations: ReadonlyMap<IRInstruction, IRInstructionLocation>,
	dominator: IRInstruction,
	target: IRInstruction,
): boolean {
	const source = locations.get(dominator);
	const destination = locations.get(target);
	if (source === undefined || destination === undefined) return false;
	return source.blockIndex === destination.blockIndex
		? source.instructionIndex <= destination.instructionIndex
		: cfg.dominates(source.blockIndex, destination.blockIndex);
}
