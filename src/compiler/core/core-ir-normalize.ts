import { coreOpcodeRegistry } from "./core-ir-opcodes.ts";
import { coreBlockId } from "./core-ir.ts";
import type {
	CoreBlockId,
	CoreEffectRefinement,
	CoreEdge,
	CoreFact,
	CoreInstructionId,
	CoreRepresentation,
	CoreTerminatorPayload,
	CoreValueId,
} from "./core-ir.ts";

interface HistoricalCoreInstruction {
	readonly id: CoreInstructionId;
	readonly opcode: string;
	readonly effectRefinement?: CoreEffectRefinement;
}

type HistoricalCoreTerminator = CoreTerminatorPayload & {
	readonly id: CoreInstructionId;
};

interface HistoricalCoreBlock {
	readonly id: CoreBlockId;
	readonly parameters: ReadonlyArray<unknown>;
	readonly instructions: ReadonlyArray<HistoricalCoreInstruction>;
	readonly terminator: HistoricalCoreTerminator;
	readonly handler?: { readonly block: CoreBlockId; readonly arguments: ReadonlyArray<CoreValueId> };
}

interface HistoricalCoreValue {
	readonly id: CoreValueId;
	readonly representation: CoreRepresentation;
	readonly definition:
		| { readonly kind: "block-parameter"; readonly block: CoreBlockId; readonly index: number }
		| { readonly kind: "instruction"; readonly instruction: CoreInstructionId; readonly index: number };
}

interface HistoricalCoreFunction {
	readonly entry: CoreBlockId;
	readonly bodyEntry?: CoreBlockId;
	readonly blocks: ReadonlyArray<HistoricalCoreBlock>;
	readonly values: ReadonlyArray<HistoricalCoreValue>;
	readonly facts: ReadonlyArray<CoreFact>;
	readonly mutationEpoch: number;
	readonly [key: string]: unknown;
}

function coreReachableBlocks(fn: HistoricalCoreFunction): ReadonlySet<CoreBlockId> {
	const reachable = new Set<CoreBlockId>([fn.entry]);
	const pending = [fn.entry];
	while (pending.length > 0) {
		const block = fn.blocks[pending.pop()!]!;
		const edges = (() => {
			switch (block.terminator.kind) {
				case "jump": return [block.terminator.edge];
				case "branch": return [block.terminator.consequent, block.terminator.alternate];
				case "guard": return [block.terminator.success, block.terminator.fallback];
				case "switch": return [...block.terminator.cases.map(({ edge }) => edge), block.terminator.default];
				case "return":
				case "throw":
				case "unreachable": return [];
			}
		})();
		for (const edge of edges) {
			if (reachable.has(edge.block)) continue;
			reachable.add(edge.block);
			pending.push(edge.block);
		}
		const canThrow = block.terminator.kind === "throw" || block.instructions.some((instruction) =>
			(instruction.effectRefinement?.effects ?? coreOpcodeRegistry.require(instruction.opcode).effects).mayThrow,
		);
		if (block.handler !== undefined && canThrow && !reachable.has(block.handler.block)) {
			reachable.add(block.handler.block);
			pending.push(block.handler.block);
		}
	}
	return reachable;
}

function remapEdge(
	edge: CoreEdge,
	blocks: ReadonlyMap<CoreBlockId, CoreBlockId>,
): CoreEdge {
	const block = blocks.get(edge.block);
	if (block === undefined) {
		throw new Error(`Cannot retain edge to removed Core block ${edge.block}`);
	}
	return { ...edge, block };
}

function remapTerminator(
	terminator: HistoricalCoreTerminator,
	blocks: ReadonlyMap<CoreBlockId, CoreBlockId>,
): HistoricalCoreTerminator {
	switch (terminator.kind) {
		case "jump":
			return { ...terminator, edge: remapEdge(terminator.edge, blocks) };
		case "branch":
			return {
				...terminator,
				consequent: remapEdge(terminator.consequent, blocks),
				alternate: remapEdge(terminator.alternate, blocks),
			};
		case "guard":
			return {
				...terminator,
				success: remapEdge(terminator.success, blocks),
				fallback: remapEdge(terminator.fallback, blocks),
			};
		case "switch":
			return {
				...terminator,
				cases: terminator.cases.map((entry) => ({
					...entry,
					edge: remapEdge(entry.edge, blocks),
				})),
				default: remapEdge(terminator.default, blocks),
			};
		case "return":
		case "throw":
		case "unreachable":
			return terminator;
	}
}

function factSurvives(fact: CoreFact, liveInstructions: ReadonlySet<number>): boolean {
	if (
		fact.validity.kind === "guard" &&
		!liveInstructions.has(fact.validity.instruction)
	) {
		return false;
	}
	return fact.obligations.every(
		(obligation) =>
			obligation.kind !== "guard" || liveInstructions.has(obligation.instruction),
	);
}

/** Restore Core's dense, reachable block space after construction or CFG rewrites. */
export function removeUnreachableCoreBlocks(fn: HistoricalCoreFunction): HistoricalCoreFunction {
	const reachable = coreReachableBlocks(fn);
	if (reachable.size === fn.blocks.length) return fn;
	const blockIds = new Map<CoreBlockId, CoreBlockId>();
	for (const block of fn.blocks) {
		if (reachable.has(block.id)) blockIds.set(block.id, coreBlockId(blockIds.size));
	}
	const liveInstructions = new Set<number>();
	for (const block of fn.blocks) {
		if (!reachable.has(block.id)) continue;
		for (const instruction of block.instructions) liveInstructions.add(instruction.id);
		liveInstructions.add(block.terminator.id);
	}
	const blocks = fn.blocks
		.filter((block) => reachable.has(block.id))
		.map((block): HistoricalCoreBlock => {
			const id = blockIds.get(block.id)!;
			const handlerTarget =
				block.handler === undefined ? undefined : blockIds.get(block.handler.block);
			return {
				...block,
				id,
				terminator: remapTerminator(block.terminator, blockIds),
				...(handlerTarget === undefined
					? { handler: undefined }
					: { handler: { ...block.handler!, block: handlerTarget } }),
			};
		});
	const values = fn.values
		.filter((value) =>
			value.definition.kind === "block-parameter"
				? blockIds.has(value.definition.block)
				: liveInstructions.has(value.definition.instruction),
		)
		.map((value) =>
			value.definition.kind !== "block-parameter"
				? value
				: {
						...value,
						definition: {
							...value.definition,
							block: blockIds.get(value.definition.block)!,
						},
					},
		);
	const entry = blockIds.get(fn.entry);
	if (entry === undefined) throw new Error("Core entry block became unreachable");
	const bodyEntry = fn.bodyEntry === undefined ? undefined : blockIds.get(fn.bodyEntry);
	return {
		...fn,
		entry,
		...(bodyEntry === undefined ? { bodyEntry: undefined } : { bodyEntry }),
		blocks,
		values,
		facts: fn.facts.filter((fact) => factSurvives(fact, liveInstructions)),
		mutationEpoch: fn.mutationEpoch + 1,
	};
}
