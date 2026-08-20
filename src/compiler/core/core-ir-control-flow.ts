import type {
	CoreBlockId,
	CoreEdge,
	CoreFunction,
	CoreOpcodeRegistry,
	CoreValueId,
} from "./core-ir.ts";
import { coreBlockId, coreValueId } from "./core-ir.ts";

export type CoreControlEdgeKind = "ordinary" | "exceptional";

export interface CoreControlEdge {
	readonly from: CoreBlockId;
	readonly to: CoreBlockId;
	readonly kind: CoreControlEdgeKind;
	readonly arguments: ReadonlyArray<CoreValueId>;
}

export interface CoreNaturalLoop {
	readonly header: CoreBlockId;
	/** Ordinary predecessors whose edge closes the loop at `header`. */
	readonly latches: ReadonlySet<CoreBlockId>;
	readonly blocks: ReadonlySet<CoreBlockId>;
	/** Unique ordinary entry block when the loop already has canonical form. */
	readonly preheader?: CoreBlockId;
	readonly exits: ReadonlyArray<{
		readonly from: CoreBlockId;
		readonly to: CoreBlockId;
		/** The target has no predecessor from outside this loop. */
		readonly dedicated: boolean;
	}>;
	/** Preheader, one identifiable latch, and dedicated ordinary exits. */
	readonly canonical: boolean;
}

/** A cyclic ordinary SCC that has no single dominating entry. */
export interface CoreIrreducibleCycle {
	readonly blocks: ReadonlySet<CoreBlockId>;
	readonly entries: ReadonlySet<CoreBlockId>;
}

export interface CoreControlFlow {
	readonly successors: ReadonlyArray<ReadonlyArray<CoreControlEdge>>;
	readonly predecessors: ReadonlyArray<ReadonlyArray<CoreControlEdge>>;
	readonly reachable: ReadonlySet<CoreBlockId>;
	readonly reversePostorder: ReadonlyArray<CoreBlockId>;
	readonly immediateDominators: ReadonlyArray<CoreBlockId | null>;
	readonly loops: ReadonlyArray<CoreNaturalLoop>;
	readonly irreducibleCycles: ReadonlyArray<CoreIrreducibleCycle>;
	dominates(dominator: CoreBlockId, block: CoreBlockId): boolean;
	/**
	 * Whether a value produced inside `dominator` is available at `block` entry.
	 * Exceptional edges leave a protected block before any instruction-defined
	 * value, so ordinary block dominance alone is insufficient.
	 */
	instructionDominatesBlock(dominator: CoreBlockId, block: CoreBlockId): boolean;
}

/**
 * Canonical producer identity through moves and all-ordinary single-value phis.
 *
 * Phi equivalences form a directed graph because loop-carried arguments can refer
 * back to one another. Condense that graph into SCCs, then solve its DAG from
 * dependencies to users. This collapses mutually recursive phis when their only
 * external producer is one value, in O(values + phi inputs) time.
 */
export function coreCanonicalValueRoots(
	fn: CoreFunction,
	cfg: CoreControlFlow,
): ReadonlyMap<CoreValueId, CoreValueId> {
	const valueCount = (fn.values.at(-1)?.id ?? -1) + 1;
	const dependencies = new Array<ReadonlyArray<CoreValueId> | undefined>(valueCount);
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			if (
				instruction.opcode !== "move" ||
				instruction.inputs.length !== 1 ||
				instruction.outputs.length !== 1
			) {
				continue;
			}
			dependencies[instruction.outputs[0]!] = instruction.inputs;
		}
	}
	for (const block of fn.blocks) {
		const incoming = cfg.predecessors[block.id]!;
		if (incoming.length === 0 || incoming.some(({ kind }) => kind !== "ordinary")) {
			continue;
		}
		for (const [index, parameter] of block.parameters.entries()) {
			const sources = incoming.map(({ arguments: arguments_ }) => arguments_[index]);
			if (sources.some((source) => source === undefined)) continue;
			dependencies[parameter.value] = sources as ReadonlyArray<CoreValueId>;
		}
	}

	const nodes = fn.values
		.map(({ id }) => id)
		.filter((value) => dependencies[value] !== undefined);
	if (nodes.length === 0) {
		return new Map(fn.values.map(({ id }) => [id, id] as const));
	}
	const reverse = new Array<Array<CoreValueId> | undefined>(valueCount);
	for (const value of nodes) {
		for (const dependency of dependencies[value]!) {
			if (dependencies[dependency] === undefined) continue;
			const users = reverse[dependency] ?? [];
			users.push(value);
			reverse[dependency] = users;
		}
	}

	const visited = new Uint8Array(valueCount);
	const postorder: Array<CoreValueId> = [];
	for (const start of nodes) {
		if (visited[start] !== 0) continue;
		visited[start] = 1;
		const stack: Array<{ readonly value: CoreValueId; next: number }> = [
			{ value: start, next: 0 },
		];
		while (stack.length > 0) {
			const frame = stack[stack.length - 1]!;
			const outgoing = dependencies[frame.value]!;
			if (frame.next < outgoing.length) {
				const dependency = outgoing[frame.next++]!;
				if (dependencies[dependency] !== undefined && visited[dependency] === 0) {
					visited[dependency] = 1;
					stack.push({ value: dependency, next: 0 });
				}
				continue;
			}
			postorder.push(frame.value);
			stack.pop();
		}
	}

	const componentOf = new Int32Array(valueCount);
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

	const componentDependencies = components.map(() => new Set<number>());
	const componentUsers = components.map(() => new Array<number>());
	for (const value of nodes) {
		const component = componentOf[value]!;
		for (const dependency of dependencies[value]!) {
			const dependencyComponent = componentOf[dependency] ?? -1;
			if (dependencyComponent >= 0 && dependencyComponent !== component) {
				componentDependencies[component]!.add(dependencyComponent);
			}
		}
	}
	for (const [component, dependencyComponents] of componentDependencies.entries()) {
		for (const dependency of dependencyComponents) {
			componentUsers[dependency]!.push(component);
		}
	}

	const canonical = new Int32Array(valueCount);
	for (const { id } of fn.values) canonical[id] = id;
	const remainingDependencies = new Uint32Array(
		componentDependencies.map(({ size }) => size),
	);
	const ready = components
		.map((_, component) => component)
		.filter((component) => remainingDependencies[component] === 0);
	while (ready.length > 0) {
		const component = ready.pop()!;
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
		for (const user of componentUsers[component]!) {
			remainingDependencies[user]!--;
			if (remainingDependencies[user] === 0) ready.push(user);
		}
	}
	return new Map(fn.values.map(({ id }) => [id, coreValueId(canonical[id]!)] as const));
}

export function coreTerminatorEdges(
	terminator: CoreFunction["blocks"][number]["terminator"],
): ReadonlyArray<CoreEdge> {
	switch (terminator.kind) {
		case "jump":
			return [terminator.edge];
		case "branch":
			return [terminator.consequent, terminator.alternate];
		case "guard":
			return [terminator.success, terminator.fallback];
		case "switch":
			return [...terminator.cases.map(({ edge }) => edge), terminator.default];
		case "return":
		case "throw":
		case "unreachable":
			return [];
	}
}

function blockHasExceptionalExit(
	fn: CoreFunction,
	blockIndex: number,
	registry: CoreOpcodeRegistry,
): boolean {
	const block = fn.blocks[blockIndex]!;
	if (block.terminator.kind === "throw") return true;
	return block.instructions.some(
		(instruction) =>
			(
				instruction.effectRefinement?.effects ??
				registry.require(instruction.opcode).effects
			).mayThrow,
	);
}

/** Reachability-only O(blocks + edges) traversal for normalization paths. */
export function coreReachableBlocks(
	fn: CoreFunction,
	registry: CoreOpcodeRegistry,
	options: BuildCoreControlFlowOptions = {},
): ReadonlySet<CoreBlockId> {
	const includeExceptions = options.exceptions !== false;
	const visited = new Uint8Array(fn.blocks.length);
	const reachable = new Set<CoreBlockId>();
	const pending = [fn.entry];
	visited[fn.entry] = 1;
	while (pending.length > 0) {
		const blockId = pending.pop()!;
		const block = fn.blocks[blockId]!;
		reachable.add(blockId);
		for (const edge of coreTerminatorEdges(block.terminator)) {
			if (visited[edge.block] !== 0) continue;
			visited[edge.block] = 1;
			pending.push(edge.block);
		}
		if (
			includeExceptions &&
			block.handler !== undefined &&
			blockHasExceptionalExit(fn, blockId, registry) &&
			visited[block.handler.block] === 0
		) {
			visited[block.handler.block] = 1;
			pending.push(block.handler.block);
		}
	}
	return reachable;
}

function buildImmediateDominators(
	entry: CoreBlockId,
	successors: ReadonlyArray<ReadonlyArray<CoreControlEdge>>,
	predecessors: ReadonlyArray<ReadonlyArray<CoreControlEdge>>,
): {
	readonly parents: Array<CoreBlockId | null>;
	readonly reachable: Set<CoreBlockId>;
	readonly reversePostorder: ReadonlyArray<CoreBlockId>;
} {
	const visited = new Uint8Array(successors.length);
	const postorder: Array<CoreBlockId> = [];
	const stack: Array<{ block: CoreBlockId; next: number }> = [{ block: entry, next: 0 }];
	visited[entry] = 1;
	while (stack.length > 0) {
		const frame = stack[stack.length - 1]!;
		const outgoing = successors[frame.block]!;
		if (frame.next < outgoing.length) {
			const target = outgoing[frame.next++]!.to;
			if (visited[target] === 0) {
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
	const rank = new Int32Array(successors.length);
	rank.fill(-1);
	for (const [index, block] of reversePostorder.entries()) rank[block] = index;
	const parents = new Array<CoreBlockId | null>(successors.length).fill(null);
	parents[entry] = entry;

	const intersect = (
		leftInitial: CoreBlockId,
		rightInitial: CoreBlockId,
	): CoreBlockId => {
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
			let parent: CoreBlockId | undefined;
			for (const { from } of predecessors[block]!) {
				if (parents[from] === null) continue;
				parent = parent === undefined ? from : intersect(parent, from);
			}
			if (parent === undefined) continue;
			if (parents[block] !== parent) {
				parents[block] = parent;
				changed = true;
			}
		}
	}
	return { parents, reachable, reversePostorder };
}

function buildDominatorPredicate(
	entryBlock: CoreBlockId,
	parents: ReadonlyArray<CoreBlockId | null>,
	reachable: ReadonlySet<CoreBlockId>,
): (dominator: CoreBlockId, block: CoreBlockId) => boolean {
	const children = parents.map(() => new Array<CoreBlockId>());
	for (const block of reachable) {
		const parent = parents[block];
		if (parent !== undefined && parent !== null && parent !== block) {
			children[parent]!.push(block);
		}
	}
	const entries = new Int32Array(parents.length);
	const exits = new Int32Array(parents.length);
	entries.fill(-1);
	exits.fill(-1);
	let clock = 0;
	const stack: Array<{ readonly block: CoreBlockId; next: number }> = [
		{ block: entryBlock, next: 0 },
	];
	entries[entryBlock] = clock++;
	while (stack.length > 0) {
		const frame = stack[stack.length - 1]!;
		const descendants = children[frame.block]!;
		if (frame.next < descendants.length) {
			const child = descendants[frame.next++]!;
			entries[child] = clock++;
			stack.push({ block: child, next: 0 });
			continue;
		}
		exits[frame.block] = clock++;
		stack.pop();
	}
	return (dominator, block) => {
		const entry = entries[dominator] ?? -1;
		const candidate = entries[block] ?? -1;
		return (
			entry >= 0 && candidate >= entry && (exits[block] ?? -1) <= (exits[dominator] ?? -1)
		);
	};
}

/**
 * Find cyclic ordinary SCCs that cannot be represented by one natural-loop
 * header. Two iterative Kosaraju walks keep the analysis linear without putting
 * a source-sized CFG on the JavaScript call stack.
 */
function findIrreducibleCycles(
	entry: CoreBlockId,
	successors: ReadonlyArray<ReadonlyArray<CoreControlEdge>>,
	predecessors: ReadonlyArray<ReadonlyArray<CoreControlEdge>>,
	reachable: ReadonlySet<CoreBlockId>,
	dominates: (dominator: CoreBlockId, block: CoreBlockId) => boolean,
): ReadonlyArray<CoreIrreducibleCycle> {
	const visited = new Uint8Array(successors.length);
	const postorder: Array<CoreBlockId> = [];
	for (const start of reachable) {
		if (visited[start] !== 0) continue;
		visited[start] = 1;
		const stack: Array<{ readonly block: CoreBlockId; next: number }> = [
			{ block: start, next: 0 },
		];
		while (stack.length > 0) {
			const frame = stack[stack.length - 1]!;
			const outgoing = successors[frame.block]!;
			let advanced = false;
			while (frame.next < outgoing.length) {
				const edge = outgoing[frame.next++]!;
				if (
					edge.kind !== "ordinary" ||
					!reachable.has(edge.to) ||
					visited[edge.to] !== 0
				) {
					continue;
				}
				visited[edge.to] = 1;
				stack.push({ block: edge.to, next: 0 });
				advanced = true;
				break;
			}
			if (advanced) continue;
			postorder.push(frame.block);
			stack.pop();
		}
	}

	const assigned = new Uint8Array(successors.length);
	const irreducible: Array<CoreIrreducibleCycle> = [];
	for (let order = postorder.length - 1; order >= 0; order -= 1) {
		const start = postorder[order]!;
		if (assigned[start] !== 0) continue;
		assigned[start] = 1;
		const blocks = new Set<CoreBlockId>();
		const pending: Array<CoreBlockId> = [start];
		while (pending.length > 0) {
			const block = pending.pop()!;
			blocks.add(block);
			for (const edge of predecessors[block]!) {
				if (
					edge.kind !== "ordinary" ||
					!reachable.has(edge.from) ||
					assigned[edge.from] !== 0
				) {
					continue;
				}
				assigned[edge.from] = 1;
				pending.push(edge.from);
			}
		}
		const cyclic =
			blocks.size > 1 ||
			successors[start]!.some((edge) => edge.kind === "ordinary" && edge.to === start);
		if (!cyclic) continue;
		const entries = new Set<CoreBlockId>();
		if (blocks.has(entry)) entries.add(entry);
		for (const block of blocks) {
			for (const edge of predecessors[block]!) {
				if (!blocks.has(edge.from)) entries.add(block);
			}
		}
		const header = entries.size === 1 ? [...entries][0]! : undefined;
		if (header === undefined || [...blocks].some((block) => !dominates(header, block))) {
			irreducible.push({ blocks, entries });
		}
	}
	const firstBlock = (cycle: CoreIrreducibleCycle): number => {
		let first = Number.POSITIVE_INFINITY;
		for (const block of cycle.blocks) first = Math.min(first, block);
		return first;
	};
	return irreducible.sort((left, right) => firstBlock(left) - firstBlock(right));
}

export interface BuildCoreControlFlowOptions {
	readonly exceptions?: boolean;
}

export function buildCoreControlFlow(
	fn: CoreFunction,
	registry: CoreOpcodeRegistry,
	options: BuildCoreControlFlowOptions = {},
): CoreControlFlow {
	const includeExceptions = options.exceptions !== false;
	const successors = fn.blocks.map((block): Array<CoreControlEdge> => {
		const outgoing: Array<CoreControlEdge> = coreTerminatorEdges(block.terminator).map(
			(edge) => ({
				from: block.id,
				to: edge.block,
				kind: "ordinary",
				arguments: edge.arguments,
			}),
		);
		if (
			includeExceptions &&
			block.handler !== undefined &&
			blockHasExceptionalExit(fn, block.id, registry)
		) {
			outgoing.push({
				from: block.id,
				to: block.handler.block,
				kind: "exceptional",
				arguments: block.handler.arguments,
			});
		}
		return outgoing;
	});
	const predecessors = Array.from(
		{ length: fn.blocks.length },
		() => new Array<CoreControlEdge>(),
	);
	for (const outgoing of successors) {
		for (const edge of outgoing) predecessors[edge.to]?.push(edge);
	}
	const { parents, reachable, reversePostorder } = buildImmediateDominators(
		fn.entry,
		successors,
		predecessors,
	);
	const dominates = buildDominatorPredicate(fn.entry, parents, reachable);

	// Split each block into entry and exit nodes. Ordinary edges leave the exit;
	// exceptional edges leave the entry because any throwing prefix can take them.
	// Dominance from source exit to destination entry is therefore the exact
	// cross-block availability rule for instruction results.
	let instructionDominatesBlock = dominates;
	if (
		successors.some((outgoing) => outgoing.some(({ kind }) => kind === "exceptional"))
	) {
		const entryNode = (block: CoreBlockId): CoreBlockId => coreBlockId(block * 2);
		const exitNode = (block: CoreBlockId): CoreBlockId => coreBlockId(block * 2 + 1);
		const splitSuccessors = Array.from(
			{ length: fn.blocks.length * 2 },
			() => new Array<CoreControlEdge>(),
		);
		const addSplitEdge = (
			from: CoreBlockId,
			to: CoreBlockId,
			kind: CoreControlEdgeKind,
		): void => {
			splitSuccessors[from]!.push({ from, to, kind, arguments: [] });
		};
		for (const block of fn.blocks) {
			addSplitEdge(entryNode(block.id), exitNode(block.id), "ordinary");
			for (const edge of successors[block.id]!) {
				addSplitEdge(
					edge.kind === "ordinary" ? exitNode(block.id) : entryNode(block.id),
					entryNode(edge.to),
					edge.kind,
				);
			}
		}
		const splitPredecessors = splitSuccessors.map(() => new Array<CoreControlEdge>());
		for (const outgoing of splitSuccessors) {
			for (const edge of outgoing) splitPredecessors[edge.to]!.push(edge);
		}
		const split = buildImmediateDominators(
			entryNode(fn.entry),
			splitSuccessors,
			splitPredecessors,
		);
		const splitDominates = buildDominatorPredicate(
			entryNode(fn.entry),
			split.parents,
			split.reachable,
		);
		instructionDominatesBlock = (dominator, block) =>
			splitDominates(exitNode(dominator), entryNode(block));
	}

	const latchesByHeader = new Map<CoreBlockId, Set<CoreBlockId>>();
	for (const from of reachable) {
		for (const edge of successors[from]!) {
			if (edge.kind !== "ordinary" || !dominates(edge.to, from)) continue;
			const latches = latchesByHeader.get(edge.to) ?? new Set<CoreBlockId>();
			latches.add(from);
			latchesByHeader.set(edge.to, latches);
		}
	}
	const loops: Array<CoreNaturalLoop> = [];
	for (const [header, latches] of latchesByHeader) {
		const blocks = new Set<CoreBlockId>([header, ...latches]);
		const pending = [...latches].filter((latch) => latch !== header);
		while (pending.length > 0) {
			const current = pending.pop()!;
			for (const predecessor of predecessors[current]!) {
				if (
					predecessor.kind !== "ordinary" ||
					!reachable.has(predecessor.from) ||
					blocks.has(predecessor.from)
				) {
					continue;
				}
				blocks.add(predecessor.from);
				if (predecessor.from !== header) pending.push(predecessor.from);
			}
		}
		const incoming = predecessors[header]!;
		const outside = incoming.filter(
			(edge) => edge.kind === "ordinary" && !blocks.has(edge.from),
		);
		const outsideSource = outside.length === 1 ? outside[0]!.from : undefined;
		const outsideTerminator =
			outsideSource === undefined ? undefined : fn.blocks[outsideSource]!.terminator;
		const preheader =
			outsideSource !== undefined &&
			incoming.length === outside.length + latches.size &&
			outsideTerminator?.kind === "jump" &&
			outsideTerminator.edge.block === header &&
			successors[outsideSource]!.length === 1
				? outsideSource
				: undefined;
		const exitByEdge = new Map<
			string,
			{ readonly from: CoreBlockId; readonly to: CoreBlockId }
		>();
		for (const from of blocks) {
			for (const edge of successors[from]!) {
				if (edge.kind !== "ordinary" || blocks.has(edge.to)) continue;
				exitByEdge.set(`${from}\0${edge.to}`, { from, to: edge.to });
			}
		}
		const exits = [...exitByEdge.values()].map(({ from, to }) => ({
			from,
			to,
			dedicated: predecessors[to]!.every(
				(edge) => edge.kind === "ordinary" && blocks.has(edge.from),
			),
		}));
		const latch = latches.size === 1 ? [...latches][0]! : undefined;
		const latchTerminator =
			latch === undefined ? undefined : fn.blocks[latch]!.terminator;
		const canonicalLatch =
			latch !== undefined &&
			latchTerminator?.kind === "jump" &&
			latchTerminator.edge.block === header &&
			successors[latch]!.length === 1;
		loops.push({
			header,
			latches,
			blocks,
			...(preheader === undefined ? {} : { preheader }),
			exits,
			canonical:
				preheader !== undefined &&
				canonicalLatch &&
				exits.every(({ dedicated }) => dedicated),
		});
	}
	loops.sort((left, right) => left.header - right.header);
	const irreducibleCycles = findIrreducibleCycles(
		fn.entry,
		successors,
		predecessors,
		reachable,
		dominates,
	);

	return {
		successors,
		predecessors,
		reachable,
		reversePostorder,
		immediateDominators: parents,
		loops,
		irreducibleCycles,
		dominates,
		instructionDominatesBlock,
	};
}
