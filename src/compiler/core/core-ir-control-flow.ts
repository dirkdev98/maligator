import { coreBlockId } from "./core-ir.ts";
import type {
	CoreBlockId,
	CoreEdge,
	CoreFunctionId,
	CoreTerminatorPayload,
	CoreValueId,
} from "./core-ir.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

export type CoreControlEdgeKind = "ordinary" | "exceptional";

export interface CoreControlEdge {
	readonly from: CoreBlockId;
	readonly to: CoreBlockId;
	readonly kind: CoreControlEdgeKind;
	readonly arguments: ReadonlyArray<CoreValueId>;
}

export interface CoreControlFlow {
	readonly function: CoreFunctionId;
	readonly cfgVersion: number;
	readonly exceptionFlowVersion: number;
	readonly successors: ReadonlyArray<ReadonlyArray<CoreControlEdge>>;
	readonly predecessors: ReadonlyArray<ReadonlyArray<CoreControlEdge>>;
	readonly reachable: ReadonlySet<CoreBlockId>;
	readonly reversePostorder: ReadonlyArray<CoreBlockId>;
	readonly immediateDominators: ReadonlyArray<CoreBlockId | null>;
	dominates(dominator: CoreBlockId, block: CoreBlockId): boolean;
	instructionDominatesBlock(dominator: CoreBlockId, block: CoreBlockId): boolean;
	dominatesEdge(from: CoreBlockId, to: CoreBlockId, block: CoreBlockId): boolean;
}

export interface BuildCoreControlFlowOptions {
	readonly exceptions?: boolean;
}

interface CachedControlFlow {
	readonly key: string;
	readonly value: CoreControlFlow;
}

const cache = new WeakMap<CoreProgram, Map<CoreFunctionId, CachedControlFlow>>();

export function coreTerminatorEdges(
	payload: CoreTerminatorPayload,
): ReadonlyArray<CoreEdge> {
	switch (payload.kind) {
		case "jump":
			return [payload.edge];
		case "branch":
			return [payload.consequent, payload.alternate];
		case "guard":
			return [payload.success, payload.fallback];
		case "switch":
			return [...payload.cases.map(({ edge }) => edge), payload.default];
		case "return":
		case "throw":
		case "unreachable":
			return [];
	}
}

function buildEdges(
	fn: CoreFunctionStore,
	includeExceptions: boolean,
): {
	readonly successors: Array<Array<CoreControlEdge>>;
	readonly predecessors: Array<Array<CoreControlEdge>>;
} {
	const successors = Array.from(
		{ length: fn.blockCapacity },
		() => new Array<CoreControlEdge>(),
	);
	const predecessors = Array.from(
		{ length: fn.blockCapacity },
		() => new Array<CoreControlEdge>(),
	);
	for (const block of fn.blockIds()) {
		const terminator = fn.terminatorPayload(fn.blockTerminator(block));
		for (const edge of coreTerminatorEdges(terminator)) {
			successors[block]!.push({
				from: block,
				to: edge.block,
				kind: "ordinary",
				arguments: edge.arguments,
			});
		}
		const handler = includeExceptions ? fn.blockHandler(block) : undefined;
		if (handler !== undefined) {
			successors[block]!.push({
				from: block,
				to: handler.block,
				kind: "exceptional",
				arguments: handler.arguments,
			});
		}
	}
	for (const outgoing of successors) {
		for (const edge of outgoing) predecessors[edge.to]?.push(edge);
	}
	return { successors, predecessors };
}

function traversal(
	entry: CoreBlockId,
	successors: ReadonlyArray<ReadonlyArray<CoreControlEdge>>,
): {
	readonly reachable: Set<CoreBlockId>;
	readonly reversePostorder: Array<CoreBlockId>;
} {
	const reachable = new Set<CoreBlockId>();
	const postorder: Array<CoreBlockId> = [];
	const pending: Array<{ readonly block: CoreBlockId; next: number }> = [
		{ block: entry, next: 0 },
	];
	reachable.add(entry);
	while (pending.length > 0) {
		const frame = pending.at(-1)!;
		const outgoing = successors[frame.block] ?? [];
		if (frame.next < outgoing.length) {
			const target = outgoing[frame.next++]!.to;
			if (!reachable.has(target)) {
				reachable.add(target);
				pending.push({ block: target, next: 0 });
			}
			continue;
		}
		postorder.push(frame.block);
		pending.pop();
	}
	return { reachable, reversePostorder: postorder.reverse() };
}

function immediateDominators(
	entry: CoreBlockId,
	reversePostorder: ReadonlyArray<CoreBlockId>,
	predecessors: ReadonlyArray<ReadonlyArray<CoreControlEdge>>,
): Array<CoreBlockId | null> {
	const order = new Int32Array(predecessors.length);
	order.fill(-1);
	for (const [index, block] of reversePostorder.entries()) order[block] = index;
	const dominators = new Int32Array(predecessors.length);
	dominators.fill(-1);
	dominators[entry] = entry;
	const intersect = (left: CoreBlockId, right: CoreBlockId): CoreBlockId => {
		let first = left;
		let second = right;
		while (first !== second) {
			while (order[first]! > order[second]!) first = coreBlockId(dominators[first]!);
			while (order[second]! > order[first]!) second = coreBlockId(dominators[second]!);
		}
		return first;
	};
	let changed = true;
	while (changed) {
		changed = false;
		for (const block of reversePostorder.slice(1)) {
			const incoming = (predecessors[block] ?? []).filter(
				({ from }) => (dominators[from] ?? -1) >= 0,
			);
			if (incoming.length === 0) continue;
			let next = incoming[0]!.from;
			for (const edge of incoming.slice(1)) next = intersect(next, edge.from);
			if (dominators[block] !== next) {
				dominators[block] = next;
				changed = true;
			}
		}
	}
	return Array.from(dominators, (parent, block) =>
		parent < 0 || block === entry ? null : coreBlockId(parent),
	);
}

function dominatorPredicate(
	entry: CoreBlockId,
	reachable: ReadonlySet<CoreBlockId>,
	parents: ReadonlyArray<CoreBlockId | null>,
): (dominator: CoreBlockId, block: CoreBlockId) => boolean {
	return (dominator, block) => {
		if (!reachable.has(dominator) || !reachable.has(block)) return false;
		let current = block;
		while (current !== dominator && current !== entry) {
			const parent = parents[current];
			if (parent === null || parent === undefined) return false;
			current = parent;
		}
		return current === dominator;
	};
}

function edgeDominates(
	entry: CoreBlockId,
	successors: ReadonlyArray<ReadonlyArray<CoreControlEdge>>,
	from: CoreBlockId,
	to: CoreBlockId,
	block: CoreBlockId,
): boolean {
	const matching = (successors[from] ?? []).filter((edge) => edge.to === to);
	if (matching.length !== 1) return false;
	const visited = new Set<CoreBlockId>([entry]);
	const pending = [entry];
	while (pending.length > 0) {
		const current = pending.pop()!;
		for (const edge of successors[current] ?? []) {
			if (edge.from === from && edge.to === to) continue;
			if (visited.has(edge.to)) continue;
			visited.add(edge.to);
			pending.push(edge.to);
		}
	}
	return !visited.has(block);
}

function build(fn: CoreFunctionStore, includeExceptions: boolean): CoreControlFlow {
	const { successors, predecessors } = buildEdges(fn, includeExceptions);
	const { reachable, reversePostorder } = traversal(fn.entry, successors);
	const parents = immediateDominators(fn.entry, reversePostorder, predecessors);
	const dominates = dominatorPredicate(fn.entry, reachable, parents);
	let instructionDominatesBlock = dominates;
	if (successors.some((edges) => edges.some(({ kind }) => kind === "exceptional"))) {
		const entryNode = (block: CoreBlockId): CoreBlockId => coreBlockId(block * 2);
		const exitNode = (block: CoreBlockId): CoreBlockId => coreBlockId(block * 2 + 1);
		const splitSuccessors = Array.from(
			{ length: fn.blockCapacity * 2 },
			() => new Array<CoreControlEdge>(),
		);
		for (const block of fn.blockIds()) {
			splitSuccessors[entryNode(block)]!.push({
				from: entryNode(block),
				to: exitNode(block),
				kind: "ordinary",
				arguments: [],
			});
			for (const edge of successors[block]!) {
				splitSuccessors[
					edge.kind === "ordinary" ? exitNode(block) : entryNode(block)
				]!.push({
					from: edge.kind === "ordinary" ? exitNode(block) : entryNode(block),
					to: entryNode(edge.to),
					kind: edge.kind,
					arguments: [],
				});
			}
		}
		const splitPredecessors = splitSuccessors.map(() => new Array<CoreControlEdge>());
		for (const outgoing of splitSuccessors) {
			for (const edge of outgoing) splitPredecessors[edge.to]!.push(edge);
		}
		const splitTraversal = traversal(entryNode(fn.entry), splitSuccessors);
		const splitParents = immediateDominators(
			entryNode(fn.entry),
			splitTraversal.reversePostorder,
			splitPredecessors,
		);
		const splitDominates = dominatorPredicate(
			entryNode(fn.entry),
			splitTraversal.reachable,
			splitParents,
		);
		instructionDominatesBlock = (dominator, block) =>
			splitDominates(exitNode(dominator), entryNode(block));
	}
	return Object.freeze({
		function: fn.id,
		cfgVersion: fn.versions.cfg,
		exceptionFlowVersion: fn.versions.exceptionFlow,
		successors: Object.freeze(successors.map((edges) => Object.freeze(edges))),
		predecessors: Object.freeze(predecessors.map((edges) => Object.freeze(edges))),
		reachable: Object.freeze(reachable),
		reversePostorder: Object.freeze(reversePostorder),
		immediateDominators: Object.freeze(parents),
		dominates,
		instructionDominatesBlock,
		dominatesEdge: (from: CoreBlockId, to: CoreBlockId, block: CoreBlockId) =>
			edgeDominates(fn.entry, successors, from, to, block),
	});
}

export function buildCoreControlFlow(
	program: CoreProgram,
	functionId: CoreFunctionId,
	options: BuildCoreControlFlowOptions = {},
): CoreControlFlow {
	const fn = program.function(functionId);
	const includeExceptions = options.exceptions !== false;
	const versions = fn.versions;
	const key = `${includeExceptions ? 1 : 0}:${versions.cfg}:${includeExceptions ? versions.exceptionFlow : 0}`;
	let programCache = cache.get(program);
	if (programCache === undefined) {
		programCache = new Map();
		cache.set(program, programCache);
	}
	const cached = programCache.get(functionId);
	if (cached?.key === key) return cached.value;
	const value = build(fn, includeExceptions);
	programCache.set(functionId, { key, value });
	return value;
}

export function corePredecessorEdges(
	program: CoreProgram,
	functionId: CoreFunctionId,
	options: BuildCoreControlFlowOptions = {},
): ReadonlyArray<ReadonlyArray<CoreControlEdge>> {
	return buildCoreControlFlow(program, functionId, options).predecessors;
}
