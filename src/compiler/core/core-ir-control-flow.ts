import type { CoreAnalysisDefinition } from "./core-analysis-manager.ts";
import { coreBlockId, coreValueId } from "./core-ir.ts";
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

export interface BuildCoreControlFlowOptions {
	readonly exceptions?: boolean;
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

function blockHasExceptionalExit(fn: CoreFunctionStore, block: CoreBlockId): boolean {
	if (fn.terminatorPayload(fn.blockTerminator(block)).kind === "throw") return true;
	for (const instruction of fn.bodyInstructionIds(block)) {
		const effects =
			fn.instructionEffectRefinement(instruction)?.effects ??
			fn.registry.byId(fn.instructionOpcode(instruction)).effects;
		if (effects.mayThrow) return true;
	}
	return false;
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
		const ordinary = coreTerminatorEdges(fn.terminatorPayload(fn.blockTerminator(block)));
		for (const [index, edge] of ordinary.entries()) {
			successors[block]!.push({
				from: block,
				to: edge.block,
				kind: "ordinary",
				get arguments() {
					return (
						coreTerminatorEdges(fn.terminatorPayload(fn.blockTerminator(block)))[index]
							?.arguments ?? edge.arguments
					);
				},
			});
		}
		const handler = includeExceptions ? fn.blockHandler(block) : undefined;
		if (handler !== undefined && blockHasExceptionalExit(fn, block)) {
			successors[block]!.push({
				from: block,
				to: handler.block,
				kind: "exceptional",
				get arguments() {
					return fn.blockHandler(block)?.arguments ?? handler.arguments;
				},
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
	const successors = Array.from(
		{ length: predecessors.length },
		() => new Array<CoreBlockId>(),
	);
	for (const [block, incoming] of predecessors.entries()) {
		for (const { from } of incoming) successors[from]!.push(coreBlockId(block));
	}
	const intersect = (left: CoreBlockId, right: CoreBlockId): CoreBlockId => {
		let first = left;
		let second = right;
		while (first !== second) {
			while (order[first]! > order[second]!) first = coreBlockId(dominators[first]!);
			while (order[second]! > order[first]!) second = coreBlockId(dominators[second]!);
		}
		return first;
	};
	const queue = reversePostorder.slice(1);
	const queued = new Uint8Array(predecessors.length);
	for (const block of queue) queued[block] = 1;
	let cursor = 0;
	while (cursor < queue.length) {
		const block = queue[cursor++]!;
		queued[block] = 0;
		const incoming = (predecessors[block] ?? []).filter(
			({ from }) => dominators[from]! >= 0,
		);
		if (incoming.length === 0) continue;
		let next = incoming[0]!.from;
		for (const edge of incoming.slice(1)) next = intersect(next, edge.from);
		if (dominators[block] === next) continue;
		dominators[block] = next;
		for (const successor of successors[block]!) {
			if (successor === entry || queued[successor] !== 0) continue;
			queued[successor] = 1;
			queue.push(successor);
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
		const outsidePayload =
			outsideSource === undefined
				? undefined
				: fn.terminatorPayload(fn.blockTerminator(outsideSource));
		const preheader =
			outsideSource !== undefined &&
			ordinaryIncoming.length === outside.length + latches.size &&
			outsidePayload?.kind === "jump" &&
			outsidePayload.edge.block === header &&
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
		const latchPayload =
			latch === undefined ? undefined : fn.terminatorPayload(fn.blockTerminator(latch));
		const canonicalLatch =
			latchPayload?.kind === "jump" &&
			latchPayload.edge.block === header &&
			(successors[latch!] ?? []).length === 1;
		const hasExceptionalControl = [...blocks].some(
			(block) =>
				fn.blockHandler(block) !== undefined ||
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

function build(fn: CoreFunctionStore, includeExceptions: boolean): CoreControlFlow {
	const { successors, predecessors } = buildEdges(fn, includeExceptions);
	const { reachable, reversePostorder } = traversal(fn.entry, successors);
	const parents = immediateDominators(fn.entry, reversePostorder, predecessors);
	const dominates = dominatorPredicate(fn.entry, reachable, parents);
	let instructionDominatesBlock = dominates;
	if (
		includeExceptions &&
		successors.some((edges) => edges.some(({ kind }) => kind === "exceptional"))
	) {
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
			for (const edge of successors[block] ?? []) {
				const from = edge.kind === "ordinary" ? exitNode(block) : entryNode(block);
				splitSuccessors[from]!.push({
					from,
					to: entryNode(edge.to),
					kind: edge.kind,
					arguments: [],
				});
			}
		}
		const splitPredecessors = splitSuccessors.map(() => new Array<CoreControlEdge>());
		for (const outgoing of splitSuccessors)
			for (const edge of outgoing) splitPredecessors[edge.to]!.push(edge);
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
	const uniqueEntryEdges = new Map<string, boolean>();
	const edgeUniquelyEnters = (from: CoreBlockId, to: CoreBlockId): boolean => {
		const key = `${from}\0${to}`;
		const cached = uniqueEntryEdges.get(key);
		if (cached !== undefined) return cached;
		const unique =
			reachable.has(from) &&
			(successors[from] ?? []).filter((edge) => edge.to === to).length === 1 &&
			(predecessors[to] ?? []).every(
				(edge) =>
					edge.from === from || !reachable.has(edge.from) || dominates(to, edge.from),
			);
		uniqueEntryEdges.set(key, unique);
		return unique;
	};
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
	return Object.freeze({
		function: fn.id,
		cfgVersion: fn.versions.cfg,
		exceptionFlowVersion: includeExceptions ? fn.versions.exceptionFlow : 0,
		successors: Object.freeze(successors.map((edges) => Object.freeze(edges))),
		predecessors: Object.freeze(predecessors.map((edges) => Object.freeze(edges))),
		reachable: Object.freeze(reachable),
		reversePostorder: Object.freeze(reversePostorder),
		immediateDominators: Object.freeze(parents),
		loops: Object.freeze(loopProducts.loops),
		irreducibleCycles: Object.freeze(irreducibleCycles),
		dominates,
		instructionDominatesBlock,
		dominatesEdge: (from: CoreBlockId, to: CoreBlockId, block: CoreBlockId) =>
			dominates(to, block) && edgeUniquelyEnters(from, to),
	});
}

export function buildCoreControlFlow(
	program: CoreProgram,
	functionId: CoreFunctionId,
	options: BuildCoreControlFlowOptions = {},
): CoreControlFlow {
	return build(program.function(functionId), options.exceptions !== false);
}

export const CORE_CONTROL_FLOW_ANALYSIS: CoreAnalysisDefinition<CoreControlFlow> = {
	key: "control-flow",
	scope: "function",
	functionDependencies: ["cfg"],
	compute({ program, request }) {
		if (request.scope !== "function") throw new Error("Expected function analysis");
		return build(program.function(request.function), false);
	},
};

export const CORE_EXCEPTION_CONTROL_FLOW_ANALYSIS: CoreAnalysisDefinition<CoreControlFlow> =
	{
		key: "exception-control-flow",
		scope: "function",
		functionDependencies: ["cfg", "exceptionFlow", "memoryEffects"],
		compute({ program, request }) {
			if (request.scope !== "function") throw new Error("Expected function analysis");
			return build(program.function(request.function), true);
		},
	};

export const CORE_EXCEPTIONAL_CONTROL_FLOW_ANALYSIS =
	CORE_EXCEPTION_CONTROL_FLOW_ANALYSIS;

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
		const inputs = fn.instructionOperands(instruction);
		const outputs = fn.instructionResults(instruction);
		if (inputs.length !== 1 || outputs.length !== 1) continue;
		dependencies[outputs[0]!] = inputs;
		nodes.push(outputs[0]!);
	}
	for (const block of fn.blockIds()) {
		const incoming = cfg.predecessors[block] ?? [];
		if (incoming.length === 0) continue;
		for (const [index, parameter] of fn.blockParameters(block).entries()) {
			if (parameter.role === "exception") continue;
			const sources = incoming.map(
				(edge) => edge.arguments[edge.kind === "exceptional" ? index - 1 : index],
			);
			if (sources.some((value) => value === undefined)) continue;
			dependencies[parameter.value] = sources as ReadonlyArray<CoreValueId>;
			nodes.push(parameter.value);
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
	functionDependencies: ["body", "cfg", "exceptionFlow"],
	compute({ program, request, get }) {
		if (request.scope !== "function") throw new Error("Expected function analysis");
		const fn = program.function(request.function);
		return coreCanonicalValueRoots(
			fn,
			get(CORE_EXCEPTIONAL_CONTROL_FLOW_ANALYSIS, request),
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
