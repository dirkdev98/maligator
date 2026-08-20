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

/** Canonical producer identity through moves and all-ordinary single-value phis. */
export function coreCanonicalValueRoots(
	fn: CoreFunction,
	cfg: CoreControlFlow,
): ReadonlyMap<CoreValueId, CoreValueId> {
	const parent = new Int32Array((fn.values.at(-1)?.id ?? -1) + 1);
	parent.fill(-1);
	for (const { id } of fn.values) parent[id] = id;
	const root = (value: CoreValueId): CoreValueId => {
		let current: number = value;
		while (parent[current] !== current) current = parent[current]!;
		const result = coreValueId(current);
		current = value;
		while (parent[current] !== current) {
			const next = parent[current]!;
			parent[current] = result;
			current = next;
		}
		return result;
	};
	// Moves are unconditional aliases. Point their producer class at the source
	// class so the representative remains the original producer when possible.
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			if (
				instruction.opcode !== "move" ||
				instruction.inputs.length !== 1 ||
				instruction.outputs.length !== 1
			) {
				continue;
			}
			const output = root(instruction.outputs[0]!);
			const source = root(instruction.inputs[0]!);
			if (output !== source) parent[output] = source;
		}
	}
	let changed = true;
	while (changed) {
		changed = false;
		for (const block of fn.blocks) {
			const incoming = cfg.predecessors[block.id]!;
			if (incoming.length === 0 || incoming.some(({ kind }) => kind !== "ordinary")) {
				continue;
			}
			for (const [index, parameter] of block.parameters.entries()) {
				const current = root(parameter.value);
				let externalSource: CoreValueId | undefined;
				let complete = true;
				for (const edge of incoming) {
					const argument = edge.arguments[index];
					if (argument === undefined) {
						complete = false;
						break;
					}
					const source = root(argument);
					// A loop-carried copy cycle contributes no new value. Collapse the
					// cycle only when every value entering it from outside has one root.
					if (source === current) continue;
					if (externalSource === undefined) externalSource = source;
					else if (externalSource !== source) {
						complete = false;
						break;
					}
				}
				if (complete && externalSource !== undefined) {
					parent[current] = externalSource;
					changed = true;
				}
			}
		}
	}
	return new Map(fn.values.map(({ id }) => [id, root(id)]));
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
