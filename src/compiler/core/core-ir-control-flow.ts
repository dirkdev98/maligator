import type {
	CoreBlockId,
	CoreEdge,
	CoreFunction,
	CoreOpcodeRegistry,
	CoreValueId,
} from "./core-ir.ts";
import { coreValueId } from "./core-ir.ts";

export type CoreControlEdgeKind = "ordinary" | "exceptional";

export interface CoreControlEdge {
	readonly from: CoreBlockId;
	readonly to: CoreBlockId;
	readonly kind: CoreControlEdgeKind;
	readonly arguments: ReadonlyArray<CoreValueId>;
}

export interface CoreNaturalLoop {
	readonly header: CoreBlockId;
	readonly backedge: CoreBlockId;
	readonly blocks: ReadonlySet<CoreBlockId>;
}

export interface CoreControlFlow {
	readonly successors: ReadonlyArray<ReadonlyArray<CoreControlEdge>>;
	readonly predecessors: ReadonlyArray<ReadonlyArray<CoreControlEdge>>;
	readonly reachable: ReadonlySet<CoreBlockId>;
	readonly reversePostorder: ReadonlyArray<CoreBlockId>;
	readonly immediateDominators: ReadonlyArray<CoreBlockId | null>;
	readonly loops: ReadonlyArray<CoreNaturalLoop>;
	dominates(dominator: CoreBlockId, block: CoreBlockId): boolean;
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
	const reverse = Array.from({ length: valueCount }, () => new Array<CoreValueId>());
	for (const value of nodes) {
		for (const dependency of dependencies[value]!) {
			if (dependencies[dependency] !== undefined) reverse[dependency]!.push(value);
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
			for (const user of reverse[value]!) {
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
			const incoming = predecessors[block]!.map(({ from }) => from).filter(
				(predecessor) => parents[predecessor] !== null,
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
	return { parents, reachable, reversePostorder };
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
	const dominatorChildren = fn.blocks.map(() => new Array<CoreBlockId>());
	for (const block of reachable) {
		const parent = parents[block];
		if (parent !== undefined && parent !== null && parent !== block) {
			dominatorChildren[parent]!.push(block);
		}
	}
	const dominatorEntry = new Int32Array(fn.blocks.length);
	const dominatorExit = new Int32Array(fn.blocks.length);
	dominatorEntry.fill(-1);
	dominatorExit.fill(-1);
	let clock = 0;
	const dominatorStack: Array<{ readonly block: CoreBlockId; next: number }> = [
		{ block: fn.entry, next: 0 },
	];
	dominatorEntry[fn.entry] = clock++;
	while (dominatorStack.length > 0) {
		const frame = dominatorStack[dominatorStack.length - 1]!;
		const children = dominatorChildren[frame.block]!;
		if (frame.next < children.length) {
			const child = children[frame.next++]!;
			dominatorEntry[child] = clock++;
			dominatorStack.push({ block: child, next: 0 });
			continue;
		}
		dominatorExit[frame.block] = clock++;
		dominatorStack.pop();
	}
	const dominates = (dominator: CoreBlockId, block: CoreBlockId): boolean => {
		const entry = dominatorEntry[dominator] ?? -1;
		const candidate = dominatorEntry[block] ?? -1;
		return (
			entry >= 0 &&
			candidate >= entry &&
			(dominatorExit[block] ?? -1) <= (dominatorExit[dominator] ?? -1)
		);
	};

	const loops: Array<CoreNaturalLoop> = [];
	for (const from of reachable) {
		for (const edge of successors[from]!) {
			if (edge.kind !== "ordinary" || !dominates(edge.to, from)) continue;
			const blocks = new Set<CoreBlockId>([edge.to, from]);
			const pending = from === edge.to ? [] : [from];
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
					if (predecessor.from !== edge.to) pending.push(predecessor.from);
				}
			}
			loops.push({ header: edge.to, backedge: from, blocks });
		}
	}

	return {
		successors,
		predecessors,
		reachable,
		reversePostorder,
		immediateDominators: parents,
		loops,
		dominates,
	};
}
