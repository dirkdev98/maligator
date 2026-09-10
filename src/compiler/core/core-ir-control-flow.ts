import type { CoreAnalysisDefinition } from "./core-analysis-manager.ts";
import { CoreAnalysisScratchPool } from "./core-analysis-scratch.ts";
import { coreBlockId, coreValueId } from "./core-ir.ts";
import type {
	CoreBlockId,
	CoreEdge,
	CoreFunctionId,
	CoreInstructionId,
	CoreTerminatorPayload,
	CoreTerminatorInput,
	CoreValueId,
} from "./core-ir.ts";
import { CORE_OPTIMIZATION_OWNER } from "./core-optimization-owners.ts";
import type { CoreOptimizationOwnerRunner } from "./core-optimization-owners.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

export type CoreControlEdgeKind = "ordinary" | "exceptional";

export interface CoreControlEdge {
	readonly from: CoreBlockId;
	readonly to: CoreBlockId;
	readonly kind: CoreControlEdgeKind;
	readonly arguments: ReadonlyArray<CoreValueId>;
}

export interface CoreNaturalLoop {
	readonly header: CoreBlockId;
	readonly latches: ReadonlySet<CoreBlockId>;
	readonly blocks: ReadonlySet<CoreBlockId>;
	readonly preheader?: CoreBlockId;
	readonly exits: ReadonlyArray<{
		readonly from: CoreBlockId;
		readonly to: CoreBlockId;
		readonly dedicated: boolean;
	}>;
	readonly canonical: boolean;
	readonly parentHeader?: CoreBlockId;
	readonly depth: number;
}

export interface CoreIrreducibleCycle {
	readonly blocks: ReadonlySet<CoreBlockId>;
	readonly entries: ReadonlySet<CoreBlockId>;
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
	readonly loops: ReadonlyArray<CoreNaturalLoop>;
	readonly irreducibleCycles: ReadonlyArray<CoreIrreducibleCycle>;
	dominates(dominator: CoreBlockId, block: CoreBlockId): boolean;
	instructionDominatesBlock(dominator: CoreBlockId, block: CoreBlockId): boolean;
	dominatesEdge(from: CoreBlockId, to: CoreBlockId, block: CoreBlockId): boolean;
}

export interface CoreStructuralControlFlow {
	readonly function: CoreFunctionId;
	readonly cfgVersion: number;
	readonly exceptionFlowVersion: number;
	readonly successors: ReadonlyArray<ReadonlyArray<CoreControlEdge>>;
	readonly predecessors: ReadonlyArray<ReadonlyArray<CoreControlEdge>>;
	readonly reachable: ReadonlySet<CoreBlockId>;
	readonly reversePostorder: ReadonlyArray<CoreBlockId>;
}

export interface CoreControlFlowBundle {
	readonly structural: CoreStructuralControlFlow;
	ordinary(): CoreControlFlow;
	exceptional(): CoreControlFlow;
}

export interface BuildCoreControlFlowOptions {
	readonly exceptions?: boolean;
}

const runWithoutOwner: CoreOptimizationOwnerRunner = (_owner, run) => run();

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

export function coreValueControlFlowUseMask(fn: CoreFunctionStore): Uint8Array {
	const appearsOnEdge = new Uint8Array(fn.valueCapacity);
	for (let blockIndex = 0; blockIndex < fn.blockCapacity; blockIndex++) {
		const block = coreBlockId(blockIndex);
		if (!fn.isBlockLive(block)) continue;
		const handlerStart = fn.kernel.blockHandlerArgumentStart(block);
		const handlerCount = fn.kernel.blockHandlerArgumentCount(block);
		for (let index = 0; index < handlerCount; index++)
			appearsOnEdge[fn.kernel.handlerArgumentAt(handlerStart + index)] = 1;
		const terminator = fn.blockTerminator(block);
		const edgeStart = fn.kernel.terminatorEdgeStart(terminator);
		const edgeCount = fn.kernel.terminatorEdgeCount(terminator);
		for (let edgeOffset = 0; edgeOffset < edgeCount; edgeOffset++) {
			const argumentStart = fn.kernel.terminatorEdgeArgumentStart(edgeStart + edgeOffset);
			const argumentCount = fn.kernel.terminatorEdgeArgumentCount(edgeStart + edgeOffset);
			for (let index = 0; index < argumentCount; index++)
				appearsOnEdge[fn.kernel.operandAt(argumentStart + index)] = 1;
		}
	}
	return appearsOnEdge;
}

function blockHasExceptionalExit(fn: CoreFunctionStore, block: CoreBlockId): boolean {
	if (fn.instructionKind(fn.blockTerminator(block)) === "throw") return true;
	for (
		let instructionIndex = fn.kernel.blockFirstInstruction(block);
		instructionIndex >= 0;
		instructionIndex = fn.kernel.instructionNext(instructionIndex as CoreInstructionId)
	) {
		const instruction = instructionIndex as CoreInstructionId;
		if (fn.kernel.instructionOpcode(instruction) < 0) continue;
		const effects =
			fn.instructionEffectRefinement(instruction)?.effects ??
			fn.registry.byId(fn.instructionOpcode(instruction)).effects;
		if (effects.mayThrow) return true;
	}
	return false;
}

function buildEdges(fn: CoreFunctionStore): {
	readonly successors: Array<Array<CoreControlEdge>>;
	readonly predecessors: Array<Array<CoreControlEdge>>;
} {
	const successors = new Array<Array<CoreControlEdge>>(fn.blockCapacity);
	const predecessors = new Array<Array<CoreControlEdge>>(fn.blockCapacity);
	const empty = Object.freeze([]) as unknown as Array<CoreControlEdge>;
	for (let blockIndex = 0; blockIndex < fn.blockCapacity; blockIndex++) {
		const block = coreBlockId(blockIndex);
		if (fn.kernel.blockLive(block) === 0) continue;
		successors[block] = empty;
		predecessors[block] = empty;
		const terminator = fn.blockTerminator(block);
		const edgeStart = fn.kernel.terminatorEdgeStart(terminator);
		const edgeCount = fn.kernel.terminatorEdgeCount(terminator);
		for (let offset = 0; offset < edgeCount; offset++) {
			const edge = edgeStart + offset;
			const argumentStart = fn.kernel.terminatorEdgeArgumentStart(edge);
			const argumentCount = fn.kernel.terminatorEdgeArgumentCount(edge);
			let argumentVersion = -1;
			let argumentsCache: ReadonlyArray<CoreValueId> | undefined;
			if (successors[block] === empty) successors[block] = [];
			successors[block].push({
				from: block,
				to: fn.kernel.terminatorEdgeBlock(edge),
				kind: "ordinary",
				get arguments() {
					const version = fn.version("body");
					if (argumentsCache === undefined || version !== argumentVersion) {
						argumentVersion = version;
						argumentsCache = Array.from({ length: argumentCount }, (_, index) =>
							fn.kernel.operandAt(argumentStart + index),
						);
					}
					return argumentsCache;
				},
			});
		}
	}
	for (const outgoing of successors) {
		if (outgoing === undefined) continue;
		for (const edge of outgoing) {
			if (predecessors[edge.to] === empty) predecessors[edge.to] = [];
			(predecessors[edge.to] ??= []).push(edge);
		}
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
	const reachable = new Set<CoreBlockId>([entry]);
	const postorder: Array<CoreBlockId> = [];
	const pending: Array<{ readonly block: CoreBlockId; next: number }> = [
		{ block: entry, next: 0 },
	];
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

function buildStructural(
	fn: CoreFunctionStore,
	runOwner: CoreOptimizationOwnerRunner,
): CoreStructuralControlFlow {
	const { successors, predecessors } = runOwner(
		CORE_OPTIMIZATION_OWNER.cfgEdgeConstruction,
		() => buildEdges(fn),
	);
	const { reachable, reversePostorder } = runOwner(
		CORE_OPTIMIZATION_OWNER.controlFlowTraversal,
		() => traversal(fn.entry, successors),
	);
	return Object.freeze({
		function: fn.id,
		cfgVersion: fn.version("cfg"),
		exceptionFlowVersion: 0,
		successors: Object.freeze(successors.map((edges) => Object.freeze(edges))),
		predecessors: Object.freeze(predecessors.map((edges) => Object.freeze(edges))),
		reachable: Object.freeze(reachable),
		reversePostorder: Object.freeze(reversePostorder),
	});
}

function buildExceptionalStructural(
	fn: CoreFunctionStore,
	ordinary: CoreStructuralControlFlow,
	runOwner: CoreOptimizationOwnerRunner,
): CoreStructuralControlFlow {
	const { successors, predecessors } = runOwner(
		CORE_OPTIMIZATION_OWNER.cfgEdgeConstruction,
		() => {
			const successors = ordinary.successors.map((edges) => [...edges]);
			const predecessors = ordinary.predecessors.map((edges) => [...edges]);
			for (const block of fn.blockIds()) {
				const handler = fn.kernel.blockHandlerBlock(block);
				if (handler === undefined || !blockHasExceptionalExit(fn, block)) continue;
				const start = fn.kernel.blockHandlerArgumentStart(block);
				const count = fn.kernel.blockHandlerArgumentCount(block);
				let argumentVersion = -1;
				let argumentsCache: ReadonlyArray<CoreValueId> | undefined;
				const edge: CoreControlEdge = {
					from: block,
					to: handler,
					kind: "exceptional",
					get arguments() {
						const version = fn.version("body");
						if (argumentsCache === undefined || version !== argumentVersion) {
							argumentVersion = version;
							argumentsCache = Array.from({ length: count }, (_, index) =>
								fn.kernel.handlerArgumentAt(start + index),
							);
						}
						return argumentsCache;
					},
				};
				successors[block]!.push(edge);
				predecessors[handler]!.push(edge);
			}
			return { successors, predecessors };
		},
	);
	const { reachable, reversePostorder } = runOwner(
		CORE_OPTIMIZATION_OWNER.controlFlowTraversal,
		() => traversal(fn.entry, successors),
	);
	return Object.freeze({
		function: fn.id,
		cfgVersion: fn.version("cfg"),
		exceptionFlowVersion: fn.version("exceptionFlow"),
		successors: Object.freeze(successors.map((edges) => Object.freeze(edges))),
		predecessors: Object.freeze(predecessors.map((edges) => Object.freeze(edges))),
		reachable: Object.freeze(reachable),
		reversePostorder: Object.freeze(reversePostorder),
	});
}

function immediateDominators(
	entry: CoreBlockId,
	reversePostorder: ReadonlyArray<CoreBlockId>,
	predecessors: ReadonlyArray<ReadonlyArray<CoreControlEdge>>,
	successors: ReadonlyArray<ReadonlyArray<CoreControlEdge>>,
	scratch: CoreAnalysisScratchPool,
): Array<CoreBlockId | null> {
	const length = predecessors.length;
	const orderLease = scratch.leaseInt32(length);
	const dominatorLease = scratch.leaseInt32(length);
	const queuedLease = scratch.leaseUint8(length);
	const order = orderLease.values;
	const dominators = dominatorLease.values;
	const queued = queuedLease.values;
	try {
		order.fill(-1, 0, length);
		for (const [index, block] of reversePostorder.entries()) order[block] = index;
		dominators.fill(-1, 0, length);
		dominators[entry] = entry;
		// Parent links contain reachable block indices; IDs are checked when publishing the result.
		const intersect = (left: number, right: number): number => {
			let first = left;
			let second = right;
			while (first !== second) {
				while (order[first]! > order[second]!) first = dominators[first]!;
				while (order[second]! > order[first]!) second = dominators[second]!;
			}
			return first;
		};
		const queue = reversePostorder.slice(1);
		queued.fill(0, 0, length);
		for (const block of queue) queued[block] = 1;
		let cursor = 0;
		while (cursor < queue.length) {
			const block = queue[cursor++]!;
			queued[block] = 0;
			let next: number | undefined;
			for (const edge of predecessors[block] ?? []) {
				if (dominators[edge.from]! < 0) continue;
				next = next === undefined ? edge.from : intersect(next, edge.from);
			}
			if (next === undefined) continue;
			if (dominators[block] === next) continue;
			dominators[block] = next;
			for (const { to: successor } of successors[block] ?? []) {
				if (successor === entry || queued[successor] !== 0) continue;
				queued[successor] = 1;
				queue.push(successor);
			}
		}
		return Array.from(dominators.subarray(0, length), (parent, block) =>
			parent < 0 || block === entry ? null : coreBlockId(parent),
		);
	} finally {
		queuedLease.release();
		dominatorLease.release();
		orderLease.release();
	}
}

function dominatorPredicate(
	entry: CoreBlockId,
	reachable: ReadonlySet<CoreBlockId>,
	parents: ReadonlyArray<CoreBlockId | null>,
): (dominator: CoreBlockId, block: CoreBlockId) => boolean {
	const children = parents.map(() => new Array<CoreBlockId>());
	for (const block of reachable) {
		const parent = parents[block];
		if (parent !== null && parent !== undefined) children[parent]!.push(block);
	}
	const entries = new Int32Array(parents.length);
	const exits = new Int32Array(parents.length);
	entries.fill(-1);
	exits.fill(-1);
	let clock = 0;
	const pending: Array<{ readonly block: CoreBlockId; next: number }> = [
		{ block: entry, next: 0 },
	];
	entries[entry] = clock++;
	while (pending.length > 0) {
		const frame = pending.at(-1)!;
		const descendants = children[frame.block] ?? [];
		if (frame.next < descendants.length) {
			const child = descendants[frame.next++]!;
			entries[child] = clock++;
			pending.push({ block: child, next: 0 });
			continue;
		}
		exits[frame.block] = clock++;
		pending.pop();
	}
	return (dominator, block) =>
		entries[dominator]! >= 0 &&
		entries[block]! >= entries[dominator]! &&
		exits[block]! <= exits[dominator]!;
}

function cyclicComponents(
	allowed: ReadonlySet<CoreBlockId>,
	successors: ReadonlyArray<ReadonlyArray<CoreControlEdge>>,
	predecessors: ReadonlyArray<ReadonlyArray<CoreControlEdge>>,
): Array<ReadonlySet<CoreBlockId>> {
	const visited = new Uint8Array(successors.length);
	const postorder: Array<CoreBlockId> = [];
	for (const start of allowed) {
		if (visited[start] !== 0) continue;
		visited[start] = 1;
		const pending: Array<{ readonly block: CoreBlockId; next: number }> = [
			{ block: start, next: 0 },
		];
		while (pending.length > 0) {
			const frame = pending.at(-1)!;
			const outgoing = successors[frame.block] ?? [];
			let advanced = false;
			while (frame.next < outgoing.length) {
				const edge = outgoing[frame.next++]!;
				if (edge.kind !== "ordinary" || !allowed.has(edge.to) || visited[edge.to] !== 0)
					continue;
				visited[edge.to] = 1;
				pending.push({ block: edge.to, next: 0 });
				advanced = true;
				break;
			}
			if (advanced) continue;
			postorder.push(frame.block);
			pending.pop();
		}
	}
	const assigned = new Uint8Array(successors.length);
	const components: Array<ReadonlySet<CoreBlockId>> = [];
	for (let index = postorder.length - 1; index >= 0; index--) {
		const start = postorder[index]!;
		if (assigned[start] !== 0) continue;
		assigned[start] = 1;
		const blocks = new Set<CoreBlockId>();
		const pending = [start];
		while (pending.length > 0) {
			const block = pending.pop()!;
			blocks.add(block);
			for (const edge of predecessors[block] ?? []) {
				if (
					edge.kind !== "ordinary" ||
					!allowed.has(edge.from) ||
					assigned[edge.from] !== 0
				)
					continue;
				assigned[edge.from] = 1;
				pending.push(edge.from);
			}
		}
		components.push(blocks);
	}
	return components;
}

function findIrreducibleCycles(
	entry: CoreBlockId,
	successors: ReadonlyArray<ReadonlyArray<CoreControlEdge>>,
	predecessors: ReadonlyArray<ReadonlyArray<CoreControlEdge>>,
	reachable: ReadonlySet<CoreBlockId>,
	dominates: (dominator: CoreBlockId, block: CoreBlockId) => boolean,
): ReadonlyArray<CoreIrreducibleCycle> {
	const isCyclic = (blocks: ReadonlySet<CoreBlockId>): boolean =>
		blocks.size > 1 ||
		[...blocks].some((block) =>
			(successors[block] ?? []).some(
				(edge) => edge.kind === "ordinary" && edge.to === block,
			),
		);
	const pending = cyclicComponents(reachable, successors, predecessors).filter(isCyclic);
	const result: Array<CoreIrreducibleCycle> = [];
	while (pending.length > 0) {
		const blocks = pending.pop()!;
		const entries = new Set<CoreBlockId>();
		if (blocks.has(entry)) entries.add(entry);
		for (const block of blocks) {
			for (const edge of predecessors[block] ?? []) {
				if (
					edge.kind === "ordinary" &&
					reachable.has(edge.from) &&
					!blocks.has(edge.from)
				)
					entries.add(block);
			}
		}
		const header = entries.size === 1 ? [...entries][0]! : undefined;
		if (header === undefined || [...blocks].some((block) => !dominates(header, block))) {
			result.push({ blocks, entries });
			continue;
		}
		const nested = new Set(blocks);
		nested.delete(header);
		pending.push(...cyclicComponents(nested, successors, predecessors).filter(isCyclic));
	}
	return result.sort(
		(left, right) => Math.min(...left.blocks) - Math.min(...right.blocks),
	);
}

function naturalLoops(
	fn: CoreFunctionStore,
	successors: ReadonlyArray<ReadonlyArray<CoreControlEdge>>,
	predecessors: ReadonlyArray<ReadonlyArray<CoreControlEdge>>,
	reachable: ReadonlySet<CoreBlockId>,
	reversePostorder: ReadonlyArray<CoreBlockId>,
	dominates: (dominator: CoreBlockId, block: CoreBlockId) => boolean,
): {
	readonly loops: ReadonlyArray<CoreNaturalLoop>;
	readonly hasNonNaturalRetreatingEdge: boolean;
} {
	const reverseIndex = new Int32Array(fn.blockCapacity);
	reverseIndex.fill(-1);
	for (const [index, block] of reversePostorder.entries()) reverseIndex[block] = index;
	const jumpsTo = (source: CoreBlockId, target: CoreBlockId): boolean => {
		const terminator = fn.blockTerminator(source);
		if (fn.instructionKind(terminator) !== "jump") return false;
		const edge = fn.kernel.terminatorEdgeStart(terminator);
		return (
			fn.kernel.terminatorEdgeCount(terminator) === 1 &&
			fn.kernel.terminatorEdgeBlock(edge) === target
		);
	};
	const latchesByHeader = new Map<CoreBlockId, Set<CoreBlockId>>();
	let hasNonNaturalRetreatingEdge = false;
	for (const from of reachable) {
		for (const edge of successors[from] ?? []) {
			if (edge.kind !== "ordinary") continue;
			if (dominates(edge.to, from)) {
				const latches = latchesByHeader.get(edge.to) ?? new Set<CoreBlockId>();
				latches.add(from);
				latchesByHeader.set(edge.to, latches);
			} else if (reverseIndex[edge.to]! <= reverseIndex[from]!) {
				hasNonNaturalRetreatingEdge = true;
			}
		}
	}
	const provisional: Array<Omit<CoreNaturalLoop, "parentHeader" | "depth">> = [];
	for (const [header, latches] of latchesByHeader) {
		const blocks = new Set<CoreBlockId>([header, ...latches]);
		const pending = [...latches].filter((latch) => latch !== header);
		while (pending.length > 0) {
			const current = pending.pop()!;
			for (const edge of predecessors[current] ?? []) {
				if (
					edge.kind !== "ordinary" ||
					!reachable.has(edge.from) ||
					blocks.has(edge.from)
				)
					continue;
				blocks.add(edge.from);
				if (edge.from !== header) pending.push(edge.from);
			}
		}
		const ordinaryIncoming = (predecessors[header] ?? []).filter(
			({ kind }) => kind === "ordinary",
		);
		const outside = ordinaryIncoming.filter(({ from }) => !blocks.has(from));
		const outsideSource = outside.length === 1 ? outside[0]!.from : undefined;
		const preheader =
			outsideSource !== undefined &&
			jumpsTo(outsideSource, header) &&
			(successors[outsideSource] ?? []).length === 1
				? outsideSource
				: undefined;
		const exitByEdge = new Map<
			string,
			{ readonly from: CoreBlockId; readonly to: CoreBlockId }
		>();
		for (const from of blocks) {
			for (const edge of successors[from] ?? []) {
				if (edge.kind !== "ordinary" || blocks.has(edge.to)) continue;
				exitByEdge.set(`${from}\0${edge.to}`, { from, to: edge.to });
			}
		}
		const exits = [...exitByEdge.values()].map(({ from, to }) => ({
			from,
			to,
			dedicated: (predecessors[to] ?? []).every(
				(edge) => edge.kind === "ordinary" && blocks.has(edge.from),
			),
		}));
		const latch = latches.size === 1 ? [...latches][0]! : undefined;
		const canonicalLatch =
			latch !== undefined &&
			jumpsTo(latch, header) &&
			(successors[latch] ?? []).length === 1;
		const hasExceptionalControl = [...blocks].some(
			(block) =>
				fn.kernel.blockHandlerBlock(block) !== undefined ||
				(predecessors[block] ?? []).some(({ kind }) => kind === "exceptional"),
		);
		provisional.push({
			header,
			latches,
			blocks,
			...(preheader === undefined ? {} : { preheader }),
			exits,
			canonical:
				preheader !== undefined &&
				canonicalLatch &&
				!hasExceptionalControl &&
				exits.every(({ dedicated }) => dedicated),
		});
	}
	provisional.sort((left, right) => left.header - right.header);
	const loops = provisional.map((loop): CoreNaturalLoop => {
		const parents = provisional
			.filter(
				(candidate) =>
					candidate !== loop &&
					candidate.blocks.size > loop.blocks.size &&
					[...loop.blocks].every((block) => candidate.blocks.has(block)),
			)
			.sort((left, right) => left.blocks.size - right.blocks.size);
		const parent = parents[0];
		let depth = 1;
		let current = parent;
		while (current !== undefined) {
			depth++;
			current = provisional
				.filter(
					(candidate) =>
						candidate !== current &&
						candidate.blocks.size > current!.blocks.size &&
						[...current!.blocks].every((block) => candidate.blocks.has(block)),
				)
				.sort((left, right) => left.blocks.size - right.blocks.size)[0];
		}
		return {
			...loop,
			...(parent === undefined ? {} : { parentHeader: parent.header }),
			depth,
		};
	});
	return { loops, hasNonNaturalRetreatingEdge };
}

function buildFromStructural(
	fn: CoreFunctionStore,
	structural: CoreStructuralControlFlow,
	includeExceptions: boolean,
	scratch: CoreAnalysisScratchPool,
	runOwner: CoreOptimizationOwnerRunner,
): CoreControlFlow {
	const { successors, predecessors, reachable, reversePostorder } = structural;
	const parents = runOwner(CORE_OPTIMIZATION_OWNER.immediateDominators, () =>
		immediateDominators(fn.entry, reversePostorder, predecessors, successors, scratch),
	);
	const dominates = dominatorPredicate(fn.entry, reachable, parents);
	// Deferred dominance must use this structural snapshot after the function changes.
	const entry = fn.entry;
	let instructionDominatesBlock:
		| ((dominator: CoreBlockId, block: CoreBlockId) => boolean)
		| undefined;
	const buildInstructionDominance = (): typeof dominates => {
		if (
			!includeExceptions ||
			!successors.some((edges) => edges.some(({ kind }) => kind === "exceptional"))
		)
			return dominates;
		const entryNode = (block: CoreBlockId): CoreBlockId => coreBlockId(block * 2);
		const exitNode = (block: CoreBlockId): CoreBlockId => coreBlockId(block * 2 + 1);
		const splitSuccessors = new Array<Array<CoreControlEdge>>(successors.length * 2);
		for (let blockIndex = 0; blockIndex < successors.length; blockIndex++) {
			const block = coreBlockId(blockIndex);
			if (successors[block] === undefined) continue;
			(splitSuccessors[entryNode(block)] ??= []).push({
				from: entryNode(block),
				to: exitNode(block),
				kind: "ordinary",
				arguments: [],
			});
			for (const edge of successors[block] ?? []) {
				const from = edge.kind === "ordinary" ? exitNode(block) : entryNode(block);
				(splitSuccessors[from] ??= []).push({
					from,
					to: entryNode(edge.to),
					kind: edge.kind,
					arguments: [],
				});
			}
		}
		const splitPredecessors = new Array<Array<CoreControlEdge>>(splitSuccessors.length);
		for (const outgoing of splitSuccessors) {
			if (outgoing === undefined) continue;
			for (const edge of outgoing) (splitPredecessors[edge.to] ??= []).push(edge);
		}
		const splitTraversal = runOwner(CORE_OPTIMIZATION_OWNER.controlFlowTraversal, () =>
			traversal(entryNode(entry), splitSuccessors),
		);
		const splitParents = runOwner(CORE_OPTIMIZATION_OWNER.immediateDominators, () =>
			immediateDominators(
				entryNode(entry),
				splitTraversal.reversePostorder,
				splitPredecessors,
				splitSuccessors,
				scratch,
			),
		);
		const splitDominates = dominatorPredicate(
			entryNode(entry),
			splitTraversal.reachable,
			splitParents,
		);
		return (dominator, block) => splitDominates(exitNode(dominator), entryNode(block));
	};
	const uniqueEntryEdges = new Map<CoreBlockId, Map<CoreBlockId, boolean>>();
	const edgeUniquelyEnters = (from: CoreBlockId, to: CoreBlockId): boolean => {
		const fromEdges = uniqueEntryEdges.get(from);
		const cached = fromEdges?.get(to);
		if (cached !== undefined) return cached;
		const unique =
			reachable.has(from) &&
			(successors[from] ?? []).filter((edge) => edge.to === to).length === 1 &&
			(predecessors[to] ?? []).every(
				(edge) =>
					edge.from === from || !reachable.has(edge.from) || dominates(to, edge.from),
			);
		const cache = fromEdges ?? new Map<CoreBlockId, boolean>();
		cache.set(to, unique);
		uniqueEntryEdges.set(from, cache);
		return unique;
	};
	const { loopProducts, irreducibleCycles } = runOwner(
		CORE_OPTIMIZATION_OWNER.loopsAndDominanceFrontiers,
		() => {
			const loopProducts = naturalLoops(
				fn,
				successors,
				predecessors,
				reachable,
				reversePostorder,
				dominates,
			);
			const irreducibleCycles = loopProducts.hasNonNaturalRetreatingEdge
				? findIrreducibleCycles(fn.entry, successors, predecessors, reachable, dominates)
				: [];
			return { loopProducts, irreducibleCycles };
		},
	);
	return Object.freeze({
		function: fn.id,
		cfgVersion: fn.version("cfg"),
		exceptionFlowVersion: includeExceptions ? fn.version("exceptionFlow") : 0,
		successors,
		predecessors,
		reachable: Object.freeze(reachable),
		reversePostorder: Object.freeze(reversePostorder),
		immediateDominators: Object.freeze(parents),
		loops: Object.freeze(loopProducts.loops),
		irreducibleCycles: Object.freeze(irreducibleCycles),
		dominates,
		instructionDominatesBlock(dominator: CoreBlockId, block: CoreBlockId) {
			return (instructionDominatesBlock ??= buildInstructionDominance())(
				dominator,
				block,
			);
		},
		dominatesEdge: (from: CoreBlockId, to: CoreBlockId, block: CoreBlockId) =>
			dominates(to, block) && edgeUniquelyEnters(from, to),
	});
}

function buildControlFlowBundle(
	fn: CoreFunctionStore,
	scratch: CoreAnalysisScratchPool,
	runOwner: CoreOptimizationOwnerRunner = runWithoutOwner,
): CoreControlFlowBundle {
	let ordinaryStructural: CoreStructuralControlFlow | undefined;
	let ordinary: CoreControlFlow | undefined;
	let structural: CoreStructuralControlFlow | undefined;
	let exceptional: CoreControlFlow | undefined;
	let ordinaryCfgVersion = -1;
	let structuralExceptionFlowVersion = -1;
	let structuralMemoryEffectsVersion = -1;
	const currentOrdinaryStructural = (): CoreStructuralControlFlow => {
		const cfgVersion = fn.version("cfg");
		if (ordinaryStructural === undefined || ordinaryCfgVersion !== cfgVersion) {
			ordinaryStructural = buildStructural(fn, runOwner);
			ordinary = undefined;
			structural = undefined;
			exceptional = undefined;
			ordinaryCfgVersion = cfgVersion;
			structuralExceptionFlowVersion = -1;
			structuralMemoryEffectsVersion = -1;
		}
		return ordinaryStructural;
	};
	const ordinaryFlow = (): CoreControlFlow => {
		const currentStructural = currentOrdinaryStructural();
		ordinary ??= buildFromStructural(fn, currentStructural, false, scratch, runOwner);
		return ordinary;
	};
	const exceptionalStructural = (): CoreStructuralControlFlow => {
		const currentOrdinary = currentOrdinaryStructural();
		if (fn.handlerBlockCount === 0) return currentOrdinary;
		const exceptionFlowVersion = fn.version("exceptionFlow");
		const memoryEffectsVersion = fn.version("memoryEffects");
		if (
			structural === undefined ||
			structuralExceptionFlowVersion !== exceptionFlowVersion ||
			structuralMemoryEffectsVersion !== memoryEffectsVersion
		) {
			structural = buildExceptionalStructural(fn, currentOrdinary, runOwner);
			exceptional = undefined;
			structuralExceptionFlowVersion = exceptionFlowVersion;
			structuralMemoryEffectsVersion = memoryEffectsVersion;
		}
		return structural;
	};
	return Object.freeze({
		get structural() {
			return exceptionalStructural();
		},
		ordinary: ordinaryFlow,
		exceptional() {
			if (fn.handlerBlockCount === 0) return ordinaryFlow();
			const currentStructural = exceptionalStructural();
			exceptional ??= buildFromStructural(fn, currentStructural, true, scratch, runOwner);
			return exceptional;
		},
	});
}

export function buildCoreControlFlow(
	program: CoreProgram,
	functionId: CoreFunctionId,
	options: BuildCoreControlFlowOptions = {},
): CoreControlFlow {
	const fn = program.function(functionId);
	const bundle = buildControlFlowBundle(fn, new CoreAnalysisScratchPool());
	return options.exceptions === false ? bundle.ordinary() : bundle.exceptional();
}

export const CORE_CONTROL_FLOW_BUNDLE_ANALYSIS: CoreAnalysisDefinition<CoreControlFlowBundle> =
	{
		key: "control-flow-bundle",
		scope: "function",
		// The stable session bundle invalidates its lazy views by function revision.
		functionDependencies: [],
		compute({ program, request, scratch, runOwner }) {
			if (request.scope !== "function") throw new Error("Expected function analysis");
			return buildControlFlowBundle(
				program.function(request.function),
				scratch,
				runOwner,
			);
		},
	};

class SparseCanonicalValueRoots extends Map<CoreValueId, CoreValueId> {
	override get(value: CoreValueId): CoreValueId {
		return super.get(value) ?? value;
	}
}

export function coreCanonicalValueRoots(
	fn: CoreFunctionStore,
	cfg: CoreControlFlow,
): ReadonlyMap<CoreValueId, CoreValueId> {
	const dependencies = new Array<ReadonlyArray<CoreValueId> | undefined>(
		fn.valueCapacity,
	);
	const nodes: Array<CoreValueId> = [];
	for (const instruction of fn.instructionIds()) {
		if (
			fn.instructionKind(instruction) !== "operation" ||
			fn.instructionOpcodeName(instruction) !== "move"
		)
			continue;
		if (
			fn.kernel.instructionOperandCount(instruction) !== 1 ||
			fn.kernel.instructionResultCount(instruction) !== 1
		)
			continue;
		const input = fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction));
		const output = fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction));
		dependencies[output] = [input];
		nodes.push(output);
	}
	for (const block of fn.blockIds()) {
		const incoming = cfg.predecessors[block] ?? [];
		if (incoming.length === 0) continue;
		const parameterStart = fn.kernel.blockParameterStart(block);
		const parameterCount = fn.kernel.blockParameterCount(block);
		for (let index = 0; index < parameterCount; index++) {
			const row = parameterStart + index;
			if (fn.kernel.blockParameterRole(row) === 1) continue;
			const parameter = fn.kernel.blockParameterValue(row);
			const sources = incoming.map(
				(edge) => edge.arguments[edge.kind === "exceptional" ? index - 1 : index],
			);
			if (sources.some((value) => value === undefined)) continue;
			dependencies[parameter] = sources as ReadonlyArray<CoreValueId>;
			nodes.push(parameter);
		}
	}
	if (nodes.length === 0) return new SparseCanonicalValueRoots();
	const reverse = new Array<Array<CoreValueId> | undefined>(fn.valueCapacity);
	for (const value of nodes) {
		for (const dependency of dependencies[value]!) {
			if (dependencies[dependency] === undefined) continue;
			const users = reverse[dependency] ?? [];
			users.push(value);
			reverse[dependency] = users;
		}
	}
	const visited = new Uint8Array(fn.valueCapacity);
	const postorder: Array<CoreValueId> = [];
	for (const start of nodes) {
		if (visited[start] !== 0) continue;
		visited[start] = 1;
		const pending: Array<{ readonly value: CoreValueId; next: number }> = [
			{ value: start, next: 0 },
		];
		while (pending.length > 0) {
			const frame = pending.at(-1)!;
			const outgoing = dependencies[frame.value]!;
			let advanced = false;
			while (frame.next < outgoing.length) {
				const dependency = outgoing[frame.next++]!;
				if (dependencies[dependency] === undefined || visited[dependency] !== 0) continue;
				visited[dependency] = 1;
				pending.push({ value: dependency, next: 0 });
				advanced = true;
				break;
			}
			if (advanced) continue;
			postorder.push(frame.value);
			pending.pop();
		}
	}
	const componentOf = new Int32Array(fn.valueCapacity);
	componentOf.fill(-1);
	const components: Array<Array<CoreValueId>> = [];
	for (let index = postorder.length - 1; index >= 0; index--) {
		const start = postorder[index]!;
		if (componentOf[start]! >= 0) continue;
		const component = components.length;
		const members: Array<CoreValueId> = [];
		components.push(members);
		componentOf[start] = component;
		const pending = [start];
		while (pending.length > 0) {
			const value = pending.pop()!;
			members.push(value);
			for (const user of reverse[value] ?? []) {
				if (componentOf[user]! >= 0) continue;
				componentOf[user] = component;
				pending.push(user);
			}
		}
	}
	const canonical = new Int32Array(fn.valueCapacity);
	for (const value of fn.valueIds()) canonical[value] = value;
	for (let component = components.length - 1; component >= 0; component--) {
		let externalRoot: number | undefined;
		let singleRoot = true;
		for (const value of components[component]!) {
			for (const dependency of dependencies[value]!) {
				if (componentOf[dependency] === component) continue;
				const root = canonical[dependency]!;
				if (externalRoot === undefined) externalRoot = root;
				else if (externalRoot !== root) singleRoot = false;
			}
		}
		if (singleRoot && externalRoot !== undefined) {
			for (const value of components[component]!) canonical[value] = externalRoot;
		}
	}
	const roots = new SparseCanonicalValueRoots();
	for (const value of fn.valueIds()) {
		const root = coreValueId(canonical[value]!);
		if (root !== value) roots.set(value, root);
	}
	return roots;
}

export const CORE_CANONICAL_VALUE_ROOTS_ANALYSIS: CoreAnalysisDefinition<
	ReadonlyMap<CoreValueId, CoreValueId>
> = {
	key: "canonical-value-roots",
	scope: "function",
	owner: CORE_OPTIMIZATION_OWNER.canonicalValueRoots,
	functionDependencies: ["body", "cfg", "exceptionFlow", "memoryEffects"],
	compute({ program, request, get }) {
		if (request.scope !== "function") throw new Error("Expected function analysis");
		const fn = program.function(request.function);
		return coreCanonicalValueRoots(
			fn,
			get(CORE_CONTROL_FLOW_BUNDLE_ANALYSIS, request).exceptional(),
		);
	},
};

export function corePredecessorEdges(
	program: CoreProgram,
	functionId: CoreFunctionId,
	options: BuildCoreControlFlowOptions = {},
): ReadonlyArray<ReadonlyArray<CoreControlEdge>> {
	return buildCoreControlFlow(program, functionId, options).predecessors;
}

function materializeTerminatorEdge(fn: CoreFunctionStore, edge: number): CoreEdge {
	const start = fn.kernel.terminatorEdgeArgumentStart(edge);
	const count = fn.kernel.terminatorEdgeArgumentCount(edge);
	const arguments_: Array<CoreValueId> = [];
	for (let index = 0; index < count; index++)
		arguments_.push(fn.kernel.operandAt(start + index));
	return { block: fn.kernel.terminatorEdgeBlock(edge), arguments: arguments_ };
}

export function coreTerminatorInput(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): CoreTerminatorInput {
	const kind = fn.instructionKind(instruction);
	const operandStart = fn.kernel.instructionOperandStart(instruction);
	const edgeStart = fn.kernel.terminatorEdgeStart(instruction);
	switch (kind) {
		case "jump":
			return { kind, edge: materializeTerminatorEdge(fn, edgeStart) };
		case "branch":
			return {
				kind,
				condition: fn.kernel.operandAt(operandStart),
				consequent: materializeTerminatorEdge(fn, edgeStart),
				alternate: materializeTerminatorEdge(fn, edgeStart + 1),
			};
		case "guard": {
			const fact = fn.kernel.terminatorFact(instruction);
			if (fact === undefined) throw new Error(`Core guard ${instruction} has no fact`);
			return {
				kind,
				condition: fn.kernel.operandAt(operandStart),
				fact,
				success: materializeTerminatorEdge(fn, edgeStart),
				fallback: materializeTerminatorEdge(fn, edgeStart + 1),
			};
		}
		case "switch": {
			const edgeCount = fn.kernel.terminatorEdgeCount(instruction);
			const cases: Array<
				Extract<CoreTerminatorInput, { kind: "switch" }>["cases"][number]
			> = [];
			for (let index = 0; index < edgeCount - 1; index++) {
				const value = fn.kernel.terminatorEdgeCaseValue(edgeStart + index);
				if (value === undefined)
					throw new Error(`Core switch ${instruction} has no case`);
				cases.push({
					value,
					edge: materializeTerminatorEdge(fn, edgeStart + index),
				});
			}
			return {
				kind,
				discriminant: fn.kernel.operandAt(operandStart),
				cases,
				default: materializeTerminatorEdge(fn, edgeStart + edgeCount - 1),
			};
		}
		case "return":
		case "throw":
			return { kind, value: fn.kernel.operandAt(operandStart) };
		case "unreachable":
			return { kind };
		case "operation":
			throw new Error(`Core instruction ${instruction} is not a terminator`);
	}
}
