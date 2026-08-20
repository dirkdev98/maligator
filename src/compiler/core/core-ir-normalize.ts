import { coreReachableBlocks } from "./core-ir-control-flow.ts";
import { coreOpcodeRegistry } from "./core-ir-opcodes.ts";
import { coreBlockId } from "./core-ir.ts";
import type {
	CoreBlock,
	CoreBlockId,
	CoreEdge,
	CoreFact,
	CoreFunction,
	CoreTerminator,
} from "./core-ir.ts";

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
	terminator: CoreTerminator,
	blocks: ReadonlyMap<CoreBlockId, CoreBlockId>,
): CoreTerminator {
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
export function removeUnreachableCoreBlocks(fn: CoreFunction): CoreFunction {
	const reachable = coreReachableBlocks(fn, coreOpcodeRegistry);
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
		.map((block): CoreBlock => {
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
