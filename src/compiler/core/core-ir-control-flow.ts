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

declare const controlEdgeBrand: unique symbol;
export type CoreControlEdge = number & { readonly [controlEdgeBrand]: true };

/** Edge points refine predecessor values after the branch outcome is known. */
export type CoreControlPoint = CoreBlockId | CoreControlEdge;

export function coreControlPointIsEdge(
	point: CoreControlPoint,
): point is CoreControlEdge {
	return point < 0;
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
	readonly edges: CoreControlEdges;
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
	readonly edges: CoreControlEdges;
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
const NO_CONTROL_EDGES: ReadonlyArray<CoreControlEdge> = [];
const emptyEdgeArguments: ReadonlyArray<CoreValueId> = [];

// Negative IDs distinguish edges from block control points. Exceptional edges
// use their source block as the row, so adding them never renumbers ordinary edges.
function ordinaryEdge(row: number): CoreControlEdge {
	return -(row * 2 + 1) as CoreControlEdge;
}

function exceptionalEdge(block: CoreBlockId): CoreControlEdge {
	return -(block * 2 + 2) as CoreControlEdge;
}

function edgeRow(edge: CoreControlEdge): number {
	return ~edge >>> 1;
}

/** Endpoints and operand ranges belong to the topology revision that named them. */
export class CoreControlEdges {
	readonly #fn: CoreFunctionStore;
	readonly #ordinary: ReadonlyArray<number>;
	readonly #exceptional: Int32Array | undefined;

	constructor(
		fn: CoreFunctionStore,
		ordinary: ReadonlyArray<number>,
		exceptional?: Int32Array,
	) {
		this.#fn = fn;
		this.#ordinary = ordinary;
		this.#exceptional = exceptional;
	}

	withExceptional(rows: Int32Array): CoreControlEdges {
		return new CoreControlEdges(this.#fn, this.#ordinary, rows);
	}

	kind(edge: CoreControlEdge): CoreControlEdgeKind {
		return (edge & 1) === 0 ? "exceptional" : "ordinary";
	}

	from(edge: CoreControlEdge): CoreBlockId {
		const row = edgeRow(edge);
		return ((edge & 1) === 0 ? row : this.#ordinary[row * 4]!) as CoreBlockId;
	}

	to(edge: CoreControlEdge): CoreBlockId {
		const row = edgeRow(edge);
		return (
			(edge & 1) === 0 ? this.#exceptional![row * 3]! : this.#ordinary[row * 4 + 1]!
		) as CoreBlockId;
	}

	argumentCount(edge: CoreControlEdge): number {
		const row = edgeRow(edge);
		return (edge & 1) === 0
			? this.#exceptional![row * 3 + 2]!
			: this.#ordinary[row * 4 + 3]!;
	}

	argument(edge: CoreControlEdge, index: number): CoreValueId | undefined {
		this.#fn.assertCurrentGeneration();
		const row = edgeRow(edge);
		const kernel = this.#fn.kernel;
		if ((edge & 1) !== 0) {
			const offset = row * 4;
			return index < 0 || index >= this.#ordinary[offset + 3]!
				? undefined
				: kernel.operandAt(this.#ordinary[offset + 2]! + index);
		}
		const offset = row * 3;
		return index < 0 || index >= this.#exceptional![offset + 2]!
			? undefined
			: kernel.handlerArgumentAt(this.#exceptional![offset + 1]! + index);
	}

	arguments(edge: CoreControlEdge): ReadonlyArray<CoreValueId> {
		const count = this.argumentCount(edge);
		if (count === 0) return emptyEdgeArguments;
		const values: Array<CoreValueId> = [];
		for (let index = 0; index < count; index++) values.push(this.argument(edge, index)!);
		return values;
	}
}

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

function exceptionalExitsMatch(
	fn: CoreFunctionStore,
	structural: CoreStructuralControlFlow,
): boolean {
	for (let index = 0; index < fn.handlerBlockCount; index++) {
		const block = fn.handlerBlockAt(index);
		const outgoing = structural.successors[block]!;
		const last = outgoing.at(-1);
		const hadExit = last !== undefined && structural.edges.kind(last) === "exceptional";
		if (hadExit !== blockHasExceptionalExit(fn, block)) return false;
	}
	return true;
}

type CoreAdjacency = ReadonlyArray<ReadonlyArray<CoreControlEdge>>;

function buildEdges(fn: CoreFunctionStore): {
	readonly successors: CoreAdjacency;
	readonly predecessors: CoreAdjacency;
	readonly edges: CoreControlEdges;
} {
	const successors = new Array<ReadonlyArray<CoreControlEdge>>(fn.blockCapacity);
	const predecessors = new Array<ReadonlyArray<CoreControlEdge>>(fn.blockCapacity);
	const counts = new Uint32Array(fn.blockCapacity);
	const rows: Array<number> = [];
	for (let blockIndex = 0; blockIndex < fn.blockCapacity; blockIndex++) {
		const block = coreBlockId(blockIndex);
		if (fn.kernel.blockLive(block) === 0) continue;
		predecessors[block] = NO_CONTROL_EDGES;
		const terminator = fn.blockTerminator(block);
		const edgeStart = fn.kernel.terminatorEdgeStart(terminator);
		const edgeCount = fn.kernel.terminatorEdgeCount(terminator);
		if (edgeCount === 0) {
			successors[block] = NO_CONTROL_EDGES;
			continue;
		}
		const outgoing = new Array<CoreControlEdge>(edgeCount);
		successors[block] = outgoing;
		for (let offset = 0; offset < edgeCount; offset++) {
			const row = edgeStart + offset;
			const to = fn.kernel.terminatorEdgeBlock(row);
			outgoing[offset] = ordinaryEdge(rows.length / 4);
			rows.push(
				block,
				to,
				fn.kernel.terminatorEdgeArgumentStart(row),
				fn.kernel.terminatorEdgeArgumentCount(row),
			);
			counts[to]!++;
		}
	}
	// The backward fill preserves predecessor order, including duplicate edges
	// from a branch or switch to the same block.
	for (let offset = rows.length - 4; offset >= 0; offset -= 4) {
		const from = rows[offset]! as CoreBlockId;
		const to = rows[offset + 1]! as CoreBlockId;
		const edge = ordinaryEdge(offset / 4);
		const index = --counts[to]!;
		const incoming = predecessors[to];
		if (incoming === undefined || incoming === NO_CONTROL_EDGES) {
			const outgoing = successors[from]!;
			if (index === 0) {
				predecessors[to] = outgoing.length === 1 ? outgoing : [edge];
				continue;
			}
			predecessors[to] = new Array<CoreControlEdge>(index + 1);
		}
		(predecessors[to] as Array<CoreControlEdge>)[index] = edge;
	}
	return { successors, predecessors, edges: new CoreControlEdges(fn, rows) };
}

class CoreBlockTopology {
	readonly #successors: CoreAdjacency;
	readonly #predecessors: CoreAdjacency;
	readonly #edges: CoreControlEdges;
	readonly #exitNodes: Uint32Array | undefined;
	readonly #exitSources: Array<CoreBlockId> = [];

	constructor(
		successors: CoreAdjacency,
		predecessors: CoreAdjacency,
		edges: CoreControlEdges,
		split = false,
	) {
		this.#successors = successors;
		this.#predecessors = predecessors;
		this.#edges = edges;
		if (split) {
			const exits = new Uint32Array(successors.length);
			for (let block = 0; block < successors.length; block++) {
				const last = successors[block]?.at(-1);
				if (last === undefined || edges.kind(last) !== "exceptional") continue;
				exits[block] = successors.length + this.#exitSources.push(coreBlockId(block));
			}
			this.#exitNodes = exits;
		}
	}

	get capacity(): number {
		return this.#successors.length + this.#exitSources.length;
	}

	exitOf(block: CoreBlockId): CoreBlockId {
		const exit = this.#exitNodes?.[block] ?? 0;
		return exit === 0 ? block : coreBlockId(exit - 1);
	}

	successorCount(block: CoreBlockId): number {
		if (block >= this.#successors.length) {
			const source = this.#exitSources[block - this.#successors.length]!;
			return this.#successors[source]!.length - 1;
		}
		if (this.exitOf(block) !== block) return 2;
		return this.#successors[block]?.length ?? 0;
	}

	successorAt(block: CoreBlockId, index: number): CoreBlockId {
		if (block >= this.#successors.length)
			return this.#edges.to(
				this.#successors[this.#exitSources[block - this.#successors.length]!]![index]!,
			);
		const outgoing = this.#successors[block]!;
		const exit = this.exitOf(block);
		if (exit === block) return this.#edges.to(outgoing[index]!);
		return index === 0 ? exit : this.#edges.to(outgoing[outgoing.length - 1]!);
	}

	predecessorCount(block: CoreBlockId): number {
		return block >= this.#successors.length
			? 1
			: (this.#predecessors[block]?.length ?? 0);
	}

	predecessorAt(block: CoreBlockId, index: number): CoreBlockId {
		if (block >= this.#successors.length)
			return this.#exitSources[block - this.#successors.length]!;
		const edge = this.#predecessors[block]![index]!;
		const source = this.#edges.from(edge);
		return this.#edges.kind(edge) === "ordinary" ? this.exitOf(source) : source;
	}
}

function traversal(
	entry: CoreBlockId,
	topology: CoreBlockTopology,
): {
	readonly reachable: Set<CoreBlockId>;
	readonly reversePostorder: Array<CoreBlockId>;
} {
	const reachable = new Set<CoreBlockId>([entry]);
	const postorder: Array<CoreBlockId> = [];
	const pending: Array<CoreBlockId> = [entry];
	const cursors = [0];
	let depth = 1;
	while (depth > 0) {
		const frame = depth - 1;
		const block = pending[frame]!;
		const next = cursors[frame]!;
		if (next < topology.successorCount(block)) {
			const target = topology.successorAt(block, next);
			cursors[frame] = next + 1;
			if (!reachable.has(target)) {
				reachable.add(target);
				pending[depth] = target;
				cursors[depth++] = 0;
			}
			continue;
		}
		postorder.push(block);
		depth--;
	}
	return { reachable, reversePostorder: postorder.reverse() };
}

function buildStructural(
	fn: CoreFunctionStore,
	runOwner: CoreOptimizationOwnerRunner,
): CoreStructuralControlFlow {
	const { successors, predecessors, edges } = runOwner(
		CORE_OPTIMIZATION_OWNER.cfgEdgeConstruction,
		() => buildEdges(fn),
	);
	const { reachable, reversePostorder } = runOwner(
		CORE_OPTIMIZATION_OWNER.controlFlowTraversal,
		() => traversal(fn.entry, new CoreBlockTopology(successors, predecessors, edges)),
	);
	return Object.freeze({
		function: fn.id,
		cfgVersion: fn.version("cfg"),
		exceptionFlowVersion: 0,
		successors,
		predecessors,
		edges,
		reachable: Object.freeze(reachable),
		reversePostorder,
	});
}

function buildExceptionalStructural(
	fn: CoreFunctionStore,
	ordinary: CoreStructuralControlFlow,
	runOwner: CoreOptimizationOwnerRunner,
): CoreStructuralControlFlow {
	const { successors, predecessors, edges } = runOwner(
		CORE_OPTIMIZATION_OWNER.cfgEdgeConstruction,
		() => {
			const successors = ordinary.successors.slice() as Array<Array<CoreControlEdge>>;
			const predecessors = ordinary.predecessors.slice() as Array<Array<CoreControlEdge>>;
			const rows = new Int32Array(fn.blockCapacity * 3);
			const mutablePredecessors = new Set<CoreBlockId>();
			const handlerBlocks = Array.from({ length: fn.handlerBlockCount }, (_, index) =>
				fn.handlerBlockAt(index),
			).sort((left, right) => left - right);
			for (const block of handlerBlocks) {
				const handler = fn.kernel.blockHandlerBlock(block);
				if (handler === undefined || !blockHasExceptionalExit(fn, block)) continue;
				const start = fn.kernel.blockHandlerArgumentStart(block);
				const count = fn.kernel.blockHandlerArgumentCount(block);
				const edge = exceptionalEdge(block);
				rows[block * 3] = handler;
				rows[block * 3 + 1] = start;
				rows[block * 3 + 2] = count;
				successors[block] = [...(successors[block] ?? []), edge];
				if (!mutablePredecessors.has(handler)) {
					predecessors[handler] = [...(predecessors[handler] ?? [])];
					mutablePredecessors.add(handler);
				}
				predecessors[handler]!.push(edge);
			}
			return { successors, predecessors, edges: ordinary.edges.withExceptional(rows) };
		},
	);
	const { reachable, reversePostorder } = runOwner(
		CORE_OPTIMIZATION_OWNER.controlFlowTraversal,
		() => traversal(fn.entry, new CoreBlockTopology(successors, predecessors, edges)),
	);
	return Object.freeze({
		function: fn.id,
		cfgVersion: fn.version("cfg"),
		exceptionFlowVersion: fn.version("exceptionFlow"),
		successors,
		predecessors,
		edges,
		reachable: Object.freeze(reachable),
		reversePostorder,
	});
}

function immediateDominators(
	entry: CoreBlockId,
	reversePostorder: ReadonlyArray<CoreBlockId>,
	topology: CoreBlockTopology,
	scratch: CoreAnalysisScratchPool,
): Array<CoreBlockId | null> {
	const length = topology.capacity;
	if (reversePostorder.length === 1)
		return new Array<CoreBlockId | null>(length).fill(null);
	const orderLease = scratch.leaseInt32(length);
	const dominatorLease = scratch.leaseInt32(length);
	const queuedLease = scratch.leaseUint8(length);
	const order = orderLease.values;
	const dominators = dominatorLease.values;
	const queued = queuedLease.values;
	try {
		order.fill(-1, 0, length);
		for (let index = 0; index < reversePostorder.length; index++)
			order[reversePostorder[index]!] = index;
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
			const predecessors = topology.predecessorCount(block);
			for (let index = 0; index < predecessors; index++) {
				const from = topology.predecessorAt(block, index);
				if (dominators[from]! < 0) continue;
				next = next === undefined ? from : intersect(next, from);
			}
			if (next === undefined) continue;
			if (dominators[block] === next) continue;
			dominators[block] = next;
			const successors = topology.successorCount(block);
			for (let index = 0; index < successors; index++) {
				const successor = topology.successorAt(block, index);
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
	if (reachable.size === 1)
		return (dominator, block) => dominator === entry && block === entry;
	const children = new Int32Array(parents.length);
	const siblings = new Int32Array(parents.length);
	children.fill(-1);
	siblings.fill(-1);
	for (const block of reachable) {
		const parent = parents[block];
		if (parent === null || parent === undefined) continue;
		siblings[block] = children[parent]!;
		children[parent] = block;
	}
	const entries = new Int32Array(parents.length);
	const exits = new Int32Array(parents.length);
	entries.fill(-1);
	exits.fill(-1);
	let clock = 0;
	const pending: Array<CoreBlockId> = [entry];
	const cursors = [children[entry]!];
	let depth = 1;
	entries[entry] = clock++;
	while (depth > 0) {
		const frame = depth - 1;
		const block = pending[frame]!;
		const next = cursors[frame]!;
		if (next >= 0) {
			const child = coreBlockId(next);
			cursors[frame] = siblings[child]!;
			entries[child] = clock++;
			pending[depth] = child;
			cursors[depth++] = children[child]!;
			continue;
		}
		exits[block] = clock++;
		depth--;
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
	edges: CoreControlEdges,
): Array<ReadonlySet<CoreBlockId>> {
	const visited = new Uint8Array(successors.length);
	const postorder: Array<CoreBlockId> = [];
	const pending: Array<CoreBlockId> = [];
	const cursors: Array<number> = [];
	for (const start of allowed) {
		if (visited[start] !== 0) continue;
		visited[start] = 1;
		pending[0] = start;
		cursors[0] = 0;
		let depth = 1;
		while (depth > 0) {
			const frame = depth - 1;
			const block = pending[frame]!;
			const outgoing = successors[block] ?? [];
			let advanced = false;
			while (cursors[frame]! < outgoing.length) {
				const edge = outgoing[cursors[frame]!]!;
				cursors[frame]!++;
				if (
					edges.kind(edge) !== "ordinary" ||
					!allowed.has(edges.to(edge)) ||
					visited[edges.to(edge)] !== 0
				)
					continue;
				visited[edges.to(edge)] = 1;
				pending[depth] = edges.to(edge);
				cursors[depth++] = 0;
				advanced = true;
				break;
			}
			if (advanced) continue;
			postorder.push(block);
			depth--;
		}
	}
	const assigned = new Uint8Array(successors.length);
	const components: Array<ReadonlySet<CoreBlockId>> = [];
	const componentPending: Array<CoreBlockId> = [];
	for (let index = postorder.length - 1; index >= 0; index--) {
		const start = postorder[index]!;
		if (assigned[start] !== 0) continue;
		assigned[start] = 1;
		const blocks = new Set<CoreBlockId>();
		componentPending.push(start);
		while (componentPending.length > 0) {
			const block = componentPending.pop()!;
			blocks.add(block);
			for (const edge of predecessors[block] ?? []) {
				if (
					edges.kind(edge) !== "ordinary" ||
					!allowed.has(edges.from(edge)) ||
					assigned[edges.from(edge)] !== 0
				)
					continue;
				assigned[edges.from(edge)] = 1;
				componentPending.push(edges.from(edge));
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
	edges: CoreControlEdges,
	reachable: ReadonlySet<CoreBlockId>,
	dominates: (dominator: CoreBlockId, block: CoreBlockId) => boolean,
): ReadonlyArray<CoreIrreducibleCycle> {
	const isCyclic = (blocks: ReadonlySet<CoreBlockId>): boolean =>
		blocks.size > 1 ||
		[...blocks].some((block) =>
			(successors[block] ?? []).some(
				(edge) => edges.kind(edge) === "ordinary" && edges.to(edge) === block,
			),
		);
	const pending = cyclicComponents(reachable, successors, predecessors, edges).filter(
		isCyclic,
	);
	const result: Array<CoreIrreducibleCycle> = [];
	while (pending.length > 0) {
		const blocks = pending.pop()!;
		const entries = new Set<CoreBlockId>();
		if (blocks.has(entry)) entries.add(entry);
		for (const block of blocks) {
			for (const edge of predecessors[block] ?? []) {
				if (
					edges.kind(edge) === "ordinary" &&
					reachable.has(edges.from(edge)) &&
					!blocks.has(edges.from(edge))
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
		pending.push(
			...cyclicComponents(nested, successors, predecessors, edges).filter(isCyclic),
		);
	}
	return result.sort(
		(left, right) => Math.min(...left.blocks) - Math.min(...right.blocks),
	);
}

function naturalLoops(
	fn: CoreFunctionStore,
	successors: ReadonlyArray<ReadonlyArray<CoreControlEdge>>,
	predecessors: ReadonlyArray<ReadonlyArray<CoreControlEdge>>,
	edges: CoreControlEdges,
	reachable: ReadonlySet<CoreBlockId>,
	reversePostorder: ReadonlyArray<CoreBlockId>,
	dominates: (dominator: CoreBlockId, block: CoreBlockId) => boolean,
): {
	readonly loops: ReadonlyArray<CoreNaturalLoop>;
	readonly hasNonNaturalRetreatingEdge: boolean;
} {
	const reverseIndex = new Int32Array(fn.blockCapacity);
	reverseIndex.fill(-1);
	for (let index = 0; index < reversePostorder.length; index++)
		reverseIndex[reversePostorder[index]!] = index;
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
			if (edges.kind(edge) !== "ordinary") continue;
			if (dominates(edges.to(edge), from)) {
				const latches = latchesByHeader.get(edges.to(edge)) ?? new Set<CoreBlockId>();
				latches.add(from);
				latchesByHeader.set(edges.to(edge), latches);
			} else if (reverseIndex[edges.to(edge)]! <= reverseIndex[from]!) {
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
					edges.kind(edge) !== "ordinary" ||
					!reachable.has(edges.from(edge)) ||
					blocks.has(edges.from(edge))
				)
					continue;
				blocks.add(edges.from(edge));
				if (edges.from(edge) !== header) pending.push(edges.from(edge));
			}
		}
		const ordinaryIncoming = (predecessors[header] ?? []).filter(
			(edge) => edges.kind(edge) === "ordinary",
		);
		const outside = ordinaryIncoming.filter((edge) => !blocks.has(edges.from(edge)));
		const outsideSource = outside.length === 1 ? edges.from(outside[0]!) : undefined;
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
				if (edges.kind(edge) !== "ordinary" || blocks.has(edges.to(edge))) continue;
				exitByEdge.set(`${from}\0${edges.to(edge)}`, { from, to: edges.to(edge) });
			}
		}
		const exits = [...exitByEdge.values()].map(({ from, to }) => ({
			from,
			to,
			dedicated: (predecessors[to] ?? []).every(
				(edge) => edges.kind(edge) === "ordinary" && blocks.has(edges.from(edge)),
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
				(predecessors[block] ?? []).some((edge) => edges.kind(edge) === "exceptional"),
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
	const { successors, predecessors, edges, reachable, reversePostorder } = structural;
	// Deferred dominance must use this structural snapshot after the function changes.
	const entry = fn.entry;
	let parents: ReadonlyArray<CoreBlockId | null> | undefined;
	const getParents = () =>
		(parents ??= runOwner(CORE_OPTIMIZATION_OWNER.immediateDominators, () =>
			immediateDominators(
				entry,
				reversePostorder,
				new CoreBlockTopology(successors, predecessors, edges),
				scratch,
			),
		));
	let predicate: ReturnType<typeof dominatorPredicate> | undefined;
	const dominates = (dominator: CoreBlockId, block: CoreBlockId): boolean =>
		(predicate ??= dominatorPredicate(entry, reachable, getParents()))(dominator, block);
	let instructionDominatesBlock:
		| ((dominator: CoreBlockId, block: CoreBlockId) => boolean)
		| undefined;
	const buildInstructionDominance = (): typeof dominates => {
		if (
			!includeExceptions ||
			!successors.some((outgoing) =>
				outgoing.some((edge) => edges.kind(edge) === "exceptional"),
			)
		)
			return dominates;
		// An exceptional exit can leave before any instruction in its source block.
		const topology = new CoreBlockTopology(successors, predecessors, edges, true);
		const splitEntry = entry;
		const splitTraversal = runOwner(CORE_OPTIMIZATION_OWNER.controlFlowTraversal, () =>
			traversal(splitEntry, topology),
		);
		const splitParents = runOwner(CORE_OPTIMIZATION_OWNER.immediateDominators, () =>
			immediateDominators(splitEntry, splitTraversal.reversePostorder, topology, scratch),
		);
		const splitDominates = dominatorPredicate(
			splitEntry,
			splitTraversal.reachable,
			splitParents,
		);
		return (dominator, block) =>
			dominator !== block && splitDominates(topology.exitOf(dominator), block);
	};
	const uniqueEntryEdges = new Map<CoreBlockId, Map<CoreBlockId, boolean>>();
	const edgeUniquelyEnters = (from: CoreBlockId, to: CoreBlockId): boolean => {
		const fromEdges = uniqueEntryEdges.get(from);
		const cached = fromEdges?.get(to);
		if (cached !== undefined) return cached;
		// A function call enters its entry block without traversing a Core edge.
		const unique =
			to !== entry &&
			reachable.has(from) &&
			(successors[from] ?? []).filter((edge) => edges.to(edge) === to).length === 1 &&
			(predecessors[to] ?? []).every(
				(edge) =>
					edges.from(edge) === from ||
					!reachable.has(edges.from(edge)) ||
					dominates(to, edges.from(edge)),
			);
		const cache = fromEdges ?? new Map<CoreBlockId, boolean>();
		cache.set(to, unique);
		uniqueEntryEdges.set(from, cache);
		return unique;
	};
	let loopAnalysis:
		| {
				readonly loops: ReadonlyArray<CoreNaturalLoop>;
				readonly irreducibleCycles: ReadonlyArray<CoreIrreducibleCycle>;
		  }
		| undefined;
	const loopsAndCycles = () =>
		(loopAnalysis ??= runOwner(CORE_OPTIMIZATION_OWNER.loopsAndDominanceFrontiers, () => {
			const loopProducts = naturalLoops(
				fn,
				successors,
				predecessors,
				edges,
				reachable,
				reversePostorder,
				dominates,
			);
			return Object.freeze({
				loops: Object.freeze(loopProducts.loops),
				irreducibleCycles: Object.freeze(
					loopProducts.hasNonNaturalRetreatingEdge
						? findIrreducibleCycles(
								fn.entry,
								successors,
								predecessors,
								edges,
								reachable,
								dominates,
							)
						: [],
				),
			});
		}));
	return Object.freeze({
		function: fn.id,
		cfgVersion: fn.version("cfg"),
		exceptionFlowVersion: includeExceptions ? fn.version("exceptionFlow") : 0,
		successors,
		predecessors,
		edges,
		reachable: Object.freeze(reachable),
		reversePostorder,
		get immediateDominators() {
			return getParents();
		},
		get loops() {
			return loopsAndCycles().loops;
		},
		get irreducibleCycles() {
			return loopsAndCycles().irreducibleCycles;
		},
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
			(structuralMemoryEffectsVersion !== memoryEffectsVersion &&
				!exceptionalExitsMatch(fn, structural))
		) {
			structural = buildExceptionalStructural(fn, currentOrdinary, runOwner);
			exceptional = undefined;
			structuralExceptionFlowVersion = exceptionFlowVersion;
		}
		structuralMemoryEffectsVersion = memoryEffectsVersion;
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
	controlEdges?: ReadonlySet<CoreControlEdge>,
	// Every normal result must equal one of these alternatives before their roots can join.
	identityInputs?: (
		instruction: CoreInstructionId,
	) => ReadonlyArray<CoreValueId> | undefined,
): ReadonlyMap<CoreValueId, CoreValueId> {
	const starts = new Int32Array(fn.valueCapacity);
	starts.fill(-1);
	const ends = new Int32Array(fn.valueCapacity);
	const inputs: Array<CoreValueId> = [];
	const nodes: Array<CoreValueId> = [];
	const add = (value: CoreValueId, start: number): void => {
		starts[value] = start;
		ends[value] = inputs.length;
		nodes.push(value);
	};

	const kernel = fn.kernel;
	for (let blockIndex = 0; blockIndex < fn.blockCapacity; blockIndex++) {
		const block = coreBlockId(blockIndex);
		if (kernel.blockLive(block) === 0) continue;
		const predecessors = cfg.predecessors[block];
		if (predecessors === undefined || predecessors.length === 0) continue;
		const parameterStart = kernel.blockParameterStart(block);
		const parameterCount = kernel.blockParameterCount(block);
		for (let index = 0; index < parameterCount; index++) {
			const row = parameterStart + index;
			if (kernel.blockParameterRole(row) === 1) continue;
			const start = inputs.length;
			for (let offset = 0; offset < predecessors.length; offset++) {
				const edge = predecessors[offset]!;
				if (controlEdges !== undefined && !controlEdges.has(edge)) continue;
				const source = cfg.edges.argument(
					edge,
					cfg.edges.kind(edge) === "exceptional" ? index - 1 : index,
				);
				if (source === undefined) {
					inputs.length = start;
					break;
				}
				inputs.push(source);
			}
			if (inputs.length > start) add(kernel.blockParameterValue(row), start);
		}
	}
	const moveOpcode = fn.registry.get("move")?.id;
	for (const instruction of fn.instructionIds()) {
		const move = kernel.instructionOpcode(instruction) === moveOpcode;
		if (
			(!move && identityInputs === undefined) ||
			kernel.instructionResultCount(instruction) !== 1
		)
			continue;
		const start = inputs.length;
		if (move && kernel.instructionOperandCount(instruction) === 1)
			inputs.push(kernel.operandAt(kernel.instructionOperandStart(instruction)));
		else {
			const alternatives = identityInputs?.(instruction);
			if (alternatives !== undefined)
				for (const alternative of alternatives) inputs.push(alternative);
		}
		if (inputs.length > start)
			add(kernel.resultAt(kernel.instructionResultStart(instruction)), start);
	}
	if (nodes.length === 0) return new SparseCanonicalValueRoots();

	// Tarjan finishes an alias component after all its external inputs. Resolve
	// these roots on completion, while both the DFS and the component stack are live.
	const visited = new Int32Array(fn.valueCapacity);
	const low = new Int32Array(fn.valueCapacity);
	const components = new Int32Array(fn.valueCapacity);
	const canonical = new Int32Array(fn.valueCapacity);
	const stack: Array<CoreValueId> = [];
	const pending: Array<CoreValueId> = [];
	const cursors: Array<number> = [];
	let clock = 0;
	let component = 0;
	const enter = (value: CoreValueId, depth: number): void => {
		visited[value] = low[value] = ++clock;
		stack.push(value);
		pending[depth] = value;
		cursors[depth] = starts[value]!;
	};
	for (const start of nodes) {
		if (visited[start] !== 0) continue;
		enter(start, 0);
		let depth = 1;
		while (depth > 0) {
			const frame = depth - 1;
			const value = pending[frame]!;
			const cursor = cursors[frame]!;
			if (cursor < ends[value]!) {
				cursors[frame] = cursor + 1;
				const dependency = inputs[cursor]!;
				if (starts[dependency] === -1) continue;
				if (visited[dependency] === 0) enter(dependency, depth++);
				else if (components[dependency] === 0)
					low[value] = Math.min(low[value]!, visited[dependency]!);
				continue;
			}
			if (low[value] === visited[value]) {
				component++;
				const end = stack.length;
				let first = end;
				do {
					components[stack[--first]!] = component;
				} while (stack[first] !== value);
				let external: number | undefined;
				let single = true;
				for (let member = first; member < end && single; member++) {
					const current = stack[member]!;
					for (let index = starts[current]!; index < ends[current]!; index++) {
						const dependency = inputs[index]!;
						if (components[dependency] === component) continue;
						const root = starts[dependency] === -1 ? dependency : canonical[dependency]!;
						if (external === undefined) external = root;
						else if (external !== root) {
							single = false;
							break;
						}
					}
				}
				for (let member = first; member < end; member++) {
					const current = stack[member]!;
					canonical[current] = single && external !== undefined ? external : current;
				}
				stack.length = first;
			}
			depth--;
			if (depth > 0) {
				const parent = pending[depth - 1]!;
				low[parent] = Math.min(low[parent]!, low[value]!);
			}
		}
	}
	const roots = new SparseCanonicalValueRoots();
	for (const value of nodes) {
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

/** Rebuilds a terminator input with each successor edge passed through `map`. */
export function mapCoreTerminatorEdges(
	input: CoreTerminatorInput,
	map: (edge: CoreEdge) => CoreEdge,
): CoreTerminatorInput {
	switch (input.kind) {
		case "jump":
			return { ...input, edge: map(input.edge) };
		case "branch":
			return {
				...input,
				consequent: map(input.consequent),
				alternate: map(input.alternate),
			};
		case "guard":
			return { ...input, success: map(input.success), fallback: map(input.fallback) };
		case "switch":
			return {
				...input,
				cases: input.cases.map((entry) => ({ ...entry, edge: map(entry.edge) })),
				default: map(input.default),
			};
		default:
			return input;
	}
}
