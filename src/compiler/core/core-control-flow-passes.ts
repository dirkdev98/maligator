import { CoreEditor } from "./core-editor.ts";
import {
	CORE_CANONICAL_VALUE_ROOTS_ANALYSIS,
	CORE_EXCEPTION_CONTROL_FLOW_ANALYSIS,
	coreTerminatorEdges,
} from "./core-ir-control-flow.ts";
import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import { CORE_LOOP_INDUCTION_ANALYSIS } from "./core-ir-loops.ts";
import type {
	CoreLoopComparison,
	CoreLoopInductionAnalysis,
	CoreNumericRange,
} from "./core-ir-loops.ts";
import {
	coreMemoryAccesses,
	coreMemoryLocationFamily,
	coreMemoryLocationIsExact,
	coreMemoryPartition,
} from "./core-ir-memory.ts";
import type { CoreMemoryPartition } from "./core-ir-memory.ts";
import { coreInstructionEffects } from "./core-ir-opcodes.ts";
import { CORE_LOCAL_PROVENANCE_ANALYSIS } from "./core-ir-provenance.ts";
import type { CoreProvenance } from "./core-ir-provenance.ts";
import { CORE_LOCAL_VALUE_KIND_ANALYSIS } from "./core-ir-value-kinds.ts";
import type {
	CoreAttributeValue,
	CoreBlockId,
	CoreEdge,
	CoreInstructionId,
	CoreMemoryFamily,
	CoreRepresentation,
	CoreTerminatorInput,
	CoreTerminatorPayload,
	CoreValueId,
} from "./core-ir.ts";
import { CORE_MEMORY_FAMILIES, CORE_MEMORY_FAMILY_DOMAINS } from "./core-ir.ts";
import type { CorePass, CorePassBudget } from "./core-pass.ts";
import type { CoreFunctionStore } from "./core-store.ts";

const CONTROL_FLOW_BUDGET: CorePassBudget = Object.freeze({
	maxWorkItems: 1_000_000,
	maxEdits: 500_000,
	exhaustion: "stop",
});

const CONTROL_FLOW_CHANGES = Object.freeze({
	cfg: true,
	calls: true,
	facts: false,
	representations: false,
});

function stableAttribute(value: CoreAttributeValue): string {
	if (Array.isArray(value)) return `[${value.map(stableAttribute).join(",")}]`;
	if (value !== null && typeof value === "object") {
		return `{${Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => `${key}:${stableAttribute(entry)}`)
			.join(",")}}`;
	}
	if (typeof value === "number") {
		return `number:${Object.is(value, -0) ? "-0" : String(value)}`;
	}
	return String(value);
}

function mapTerminatorEdges(
	payload: CoreTerminatorPayload,
	map: (edge: CoreEdge) => CoreEdge,
): CoreTerminatorInput {
	switch (payload.kind) {
		case "jump":
			return { kind: "jump", edge: map(payload.edge) };
		case "branch":
			return {
				kind: "branch",
				condition: payload.condition,
				consequent: map(payload.consequent),
				alternate: map(payload.alternate),
			};
		case "guard":
			return {
				kind: "guard",
				condition: payload.condition,
				fact: payload.fact,
				success: map(payload.success),
				fallback: map(payload.fallback),
			};
		case "switch":
			return {
				kind: "switch",
				discriminant: payload.discriminant,
				cases: payload.cases.map(({ value, edge }) => ({ value, edge: map(edge) })),
				default: map(payload.default),
			};
		case "return":
			return { kind: "return", value: payload.value };
		case "throw":
			return { kind: "throw", value: payload.value };
		case "unreachable":
			return { kind: "unreachable" };
	}
}

function expressionKey(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	inputs = fn.instructionOperands(instruction),
): string | undefined {
	if (fn.instructionKind(instruction) !== "operation") return undefined;
	const descriptor = fn.registry.byId(fn.instructionOpcode(instruction));
	const effects =
		fn.instructionEffectRefinement(instruction)?.effects ?? descriptor.effects;
	const outputs = fn.instructionResults(instruction);
	if (
		!descriptor.discardable ||
		descriptor.callTransfer !== undefined ||
		outputs.length !== 1 ||
		effects.mayThrow ||
		effects.maySuspend ||
		effects.mayGc ||
		effects.callsUserCode ||
		effects.reads.length > 0 ||
		effects.writes.length > 0
	)
		return undefined;
	return `${descriptor.opcode}|${inputs.join(",")}|${stableAttribute(fn.instructionAttributes(instruction))}|${fn.valueRepresentation(outputs[0]!)}`;
}

function blockParameterSpecs(fn: CoreFunctionStore, block: CoreBlockId) {
	return fn.blockParameters(block).map(({ representation, role }) => ({
		representation,
		role,
	}));
}

const canonicalizeNaturalLoops: CorePass = {
	name: "natural-loop-canonicalization",
	stage: "control-flow",
	scope: "function",
	requiredAnalyses: [CORE_EXCEPTION_CONTROL_FLOW_ANALYSIS],
	wakesOn: ["cfg", "exceptionFlow"],
	preserves: [],
	changes: CONTROL_FLOW_CHANGES,
	budget: CONTROL_FLOW_BUDGET,
	run(context) {
		const { program, item } = context;
		if (item.scope !== "function") return undefined;
		const fn = program.function(item.function);
		const cfg = context.analysis(CORE_EXCEPTION_CONTROL_FLOW_ANALYSIS);
		for (const loop of cfg.loops) {
			if (
				[...loop.blocks].some(
					(block) =>
						fn.blockHandler(block) !== undefined ||
						(cfg.predecessors[block] ?? []).some(({ kind }) => kind === "exceptional"),
				)
			)
				continue;
			const redirect = (
				editor: CoreEditor,
				source: CoreBlockId,
				target: CoreBlockId,
				replacement: CoreBlockId,
			): void => {
				editor.replaceTerminator(
					source,
					mapTerminatorEdges(fn.terminatorPayload(fn.blockTerminator(source)), (edge) =>
						edge.block === target
							? { block: replacement, arguments: edge.arguments }
							: edge,
					),
				);
			};
			if (loop.preheader === undefined) {
				const outside = (cfg.predecessors[loop.header] ?? []).filter(
					(edge) => edge.kind === "ordinary" && !loop.blocks.has(edge.from),
				);
				if (outside.length === 0) continue;
				const editor = CoreEditor.open(program, item.function);
				const preheader = editor.createBlock(blockParameterSpecs(fn, loop.header));
				for (const source of new Set(outside.map(({ from }) => from))) {
					redirect(editor, source, loop.header, preheader);
				}
				editor.setTerminator(preheader, {
					kind: "jump",
					edge: {
						block: loop.header,
						arguments: fn.blockParameters(preheader).map(({ value }) => value),
					},
				});
				return editor.commit();
			}
			const soleLatch = loop.latches.size === 1 ? [...loop.latches][0]! : undefined;
			const soleLatchPayload =
				soleLatch === undefined
					? undefined
					: fn.terminatorPayload(fn.blockTerminator(soleLatch));
			if (
				soleLatch === undefined ||
				soleLatchPayload?.kind !== "jump" ||
				soleLatchPayload.edge.block !== loop.header ||
				(cfg.successors[soleLatch] ?? []).length !== 1
			) {
				const editor = CoreEditor.open(program, item.function);
				const latch = editor.createBlock(blockParameterSpecs(fn, loop.header));
				for (const source of loop.latches) redirect(editor, source, loop.header, latch);
				editor.setTerminator(latch, {
					kind: "jump",
					edge: {
						block: loop.header,
						arguments: fn.blockParameters(latch).map(({ value }) => value),
					},
				});
				return editor.commit();
			}
			const exit = loop.exits.find(({ dedicated }) => !dedicated);
			if (exit !== undefined) {
				if (fn.blockParameters(exit.to).some(({ role }) => role === "exception"))
					continue;
				const editor = CoreEditor.open(program, item.function);
				const dedicated = editor.createBlock(blockParameterSpecs(fn, exit.to));
				redirect(editor, exit.from, exit.to, dedicated);
				editor.setTerminator(dedicated, {
					kind: "jump",
					edge: {
						block: exit.to,
						arguments: fn.blockParameters(dedicated).map(({ value }) => value),
					},
				});
				return editor.commit();
			}
		}
		return undefined;
	},
};

interface CoreLoopWriteSummary {
	readonly opaque: ReadonlySet<CoreMemoryFamily>;
	readonly inexact: ReadonlySet<CoreMemoryFamily>;
	readonly partitions: ReadonlyMap<CoreMemoryFamily, ReadonlySet<CoreMemoryPartition>>;
}

function summarizeLoopWrites(
	fn: CoreFunctionStore,
	loopBlocks: ReadonlySet<CoreBlockId>,
): CoreLoopWriteSummary {
	const opaque = new Set<CoreMemoryFamily>();
	const inexact = new Set<CoreMemoryFamily>();
	const partitions = new Map<CoreMemoryFamily, Set<CoreMemoryPartition>>();
	for (const block of loopBlocks) {
		for (const instruction of fn.bodyInstructionIds(block)) {
			const effects = coreInstructionEffects(fn, instruction);
			const writes = coreMemoryAccesses(fn, instruction).filter(
				(access) => access.mode === "write",
			);
			for (const family of CORE_MEMORY_FAMILIES) {
				const familyWrites = writes.filter(
					(write) => coreMemoryLocationFamily(write.location) === family,
				);
				if (
					effects.writes.some((domain) =>
						CORE_MEMORY_FAMILY_DOMAINS[family].includes(domain),
					) &&
					familyWrites.length === 0
				) {
					opaque.add(family);
				}
				for (const write of familyWrites) {
					if (!coreMemoryLocationIsExact(write.location)) {
						inexact.add(family);
						continue;
					}
					const familyPartitions = partitions.get(family) ?? new Set();
					familyPartitions.add(coreMemoryPartition(write.location));
					partitions.set(family, familyPartitions);
				}
			}
		}
	}
	return { opaque, inexact, partitions };
}

function loopWriteMayAliasRead(
	fn: CoreFunctionStore,
	writes: CoreLoopWriteSummary,
	readInstruction: CoreInstructionId,
): boolean {
	const reads = coreMemoryAccesses(fn, readInstruction).filter(
		(access) => access.mode === "read",
	);
	if (reads.length === 0)
		return coreInstructionEffects(fn, readInstruction).reads.length > 0;
	if (reads.some(({ location }) => !coreMemoryLocationIsExact(location))) return true;
	for (const read of reads) {
		if (!coreMemoryLocationIsExact(read.location)) return true;
		const family = coreMemoryLocationFamily(read.location);
		if (writes.opaque.has(family) || writes.inexact.has(family)) return true;
		if (writes.partitions.get(family)?.has(coreMemoryPartition(read.location))) {
			return true;
		}
	}
	return false;
}

function isContainedArrayLengthRead(
	fn: CoreFunctionStore,
	provenance: CoreProvenance,
	instruction: CoreInstructionId,
): boolean {
	if (fn.instructionOpcodeName(instruction) !== "loadPropertyStatic") return false;
	const [base] = fn.instructionOperands(instruction);
	const stringIndex = fn.instructionAttributes(instruction).stringIndex;
	if (base === undefined || typeof stringIndex !== "number") return false;
	const exact = provenance.ownCell(
		base,
		{ kind: "string-constant", index: stringIndex },
		"read",
	);
	return exact?.layout.kind === "indexed" && exact.cell.kind === "object-slot";
}

const hoistLoopInvariants: CorePass = {
	name: "loop-invariant-code-motion",
	stage: "control-flow",
	scope: "function",
	requiredAnalyses: [
		CORE_EXCEPTION_CONTROL_FLOW_ANALYSIS,
		CORE_LOCAL_PROVENANCE_ANALYSIS,
	],
	wakesOn: ["body", "cfg", "exceptionFlow", "memoryEffects"],
	preserves: ["control-flow", "exception-control-flow"],
	changes: { ...CONTROL_FLOW_CHANGES, cfg: false, facts: true },
	budget: CONTROL_FLOW_BUDGET,
	run(context) {
		const { program, item } = context;
		if (item.scope !== "function") return undefined;
		const fn = program.function(item.function);
		const cfg = context.analysis(CORE_EXCEPTION_CONTROL_FLOW_ANALYSIS);
		const provenance = context.analysis(CORE_LOCAL_PROVENANCE_ANALYSIS);
		const moves: Array<{
			readonly instruction: CoreInstructionId;
			readonly preheader: CoreBlockId;
		}> = [];
		const selected = new Set<CoreInstructionId>();
		for (const loop of [...cfg.loops].sort((left, right) => right.depth - left.depth)) {
			if (!loop.canonical || loop.preheader === undefined) continue;
			const loopWrites = summarizeLoopWrites(fn, loop.blocks);
			for (const block of loop.blocks) {
				for (const instruction of [...fn.bodyInstructionIds(block)]) {
					if (selected.has(instruction)) continue;
					if (fn.instructionKind(instruction) !== "operation") continue;
					const descriptor = fn.registry.byId(fn.instructionOpcode(instruction));
					const effects = coreInstructionEffects(fn, instruction);
					const containedArrayLength = isContainedArrayLengthRead(
						fn,
						provenance,
						instruction,
					);
					if (
						(!containedArrayLength &&
							(!descriptor.discardable ||
								effects.mayThrow ||
								effects.maySuspend ||
								effects.mayGc ||
								effects.callsUserCode ||
								effects.writes.length > 0)) ||
						fn.instructionOperands(instruction).some((value) => {
							const definition = fn.valueDefinition(value);
							return definition.kind === "instruction"
								? loop.blocks.has(fn.instructionBlock(definition.instruction))
								: loop.blocks.has(definition.block);
						}) ||
						(!containedArrayLength && loopWriteMayAliasRead(fn, loopWrites, instruction))
					)
						continue;
					moves.push({ instruction, preheader: loop.preheader });
					selected.add(instruction);
					if (moves.length >= context.remainingEdits) break;
				}
				if (moves.length >= context.remainingEdits) break;
			}
			if (moves.length >= context.remainingEdits) break;
		}
		if (moves.length === 0) return undefined;
		const editor = CoreEditor.open(program, item.function);
		for (const { instruction, preheader } of moves) {
			editor.moveInstruction(instruction, preheader);
		}
		return editor.commit();
	},
};

const eliminateDominatedRedundancy: CorePass = {
	name: "dominance-redundancy-elimination",
	stage: "control-flow",
	scope: "function",
	requiredAnalyses: [
		CORE_EXCEPTION_CONTROL_FLOW_ANALYSIS,
		CORE_CANONICAL_VALUE_ROOTS_ANALYSIS,
	],
	wakesOn: ["body", "cfg", "exceptionFlow"],
	preserves: ["exception-control-flow"],
	changes: { ...CONTROL_FLOW_CHANGES, cfg: false, facts: true },
	budget: CONTROL_FLOW_BUDGET,
	run(context) {
		const { program, item } = context;
		if (item.scope !== "function") return undefined;
		const fn = program.function(item.function);
		const cfg = context.analysis(CORE_EXCEPTION_CONTROL_FLOW_ANALYSIS);
		const roots = context.analysis(CORE_CANONICAL_VALUE_ROOTS_ANALYSIS);
		const available = new Array<Map<string, CoreValueId>>(fn.blockCapacity);
		const replacements = new Map<CoreInstructionId, CoreValueId>();
		for (const block of cfg.reversePostorder) {
			const parent = cfg.immediateDominators[block];
			const current = new Map(
				parent === null || parent === undefined ? [] : available[parent],
			);
			for (const instruction of fn.bodyInstructionIds(block)) {
				const rooted = fn
					.instructionOperands(instruction)
					.map((value) => roots.get(value) ?? value);
				const key = expressionKey(fn, instruction, rooted);
				if (key === undefined) continue;
				const existing = current.get(key);
				const existingDefinition =
					existing === undefined ? undefined : fn.valueDefinition(existing);
				const existingBlock =
					existingDefinition?.kind === "instruction"
						? fn.instructionBlock(existingDefinition.instruction)
						: existingDefinition?.block;
				if (
					existing === undefined ||
					existingBlock === undefined ||
					(existingBlock !== block &&
						!cfg.instructionDominatesBlock(existingBlock, block))
				)
					current.set(key, fn.instructionResults(instruction)[0]!);
				else replacements.set(instruction, existing);
			}
			available[block] = current;
		}
		if (replacements.size === 0) return undefined;
		const editor = CoreEditor.open(program, item.function);
		for (const [instruction, replacement] of replacements) {
			if (!fn.isInstructionLive(instruction)) continue;
			const result = fn.instructionResults(instruction)[0];
			if (result === undefined) continue;
			editor.replaceValueUses(result, replacement);
			editor.removeInstruction(instruction);
		}
		return editor.commit();
	},
};

function translatedInputs(
	fn: CoreFunctionStore,
	cfg: CoreControlFlow,
	block: CoreBlockId,
	predecessor: CoreBlockId,
	edge: CoreEdge,
	inputs: ReadonlyArray<CoreValueId>,
): ReadonlyArray<CoreValueId> | undefined {
	const parameters = fn.blockParameters(block);
	const translated: Array<CoreValueId> = [];
	for (const input of inputs) {
		const parameter = parameters.findIndex(({ value }) => value === input);
		if (parameter >= 0) {
			const value = edge.arguments[parameter];
			if (value === undefined) return undefined;
			translated.push(value);
			continue;
		}
		const definition = fn.valueDefinition(input);
		const definitionBlock =
			definition.kind === "instruction"
				? fn.instructionBlock(definition.instruction)
				: definition.block;
		if (
			definitionBlock === block ||
			!cfg.instructionDominatesBlock(definitionBlock, predecessor)
		)
			return undefined;
		translated.push(input);
	}
	return translated;
}

const eliminatePartialRedundancy: CorePass = {
	name: "partial-redundancy-elimination",
	stage: "control-flow",
	scope: "function",
	requiredAnalyses: [CORE_EXCEPTION_CONTROL_FLOW_ANALYSIS],
	wakesOn: ["body", "cfg", "exceptionFlow"],
	preserves: [],
	changes: { ...CONTROL_FLOW_CHANGES, facts: true },
	budget: CONTROL_FLOW_BUDGET,
	run(context) {
		const { program, item } = context;
		if (item.scope !== "function") return undefined;
		const fn = program.function(item.function);
		const cfg = context.analysis(CORE_EXCEPTION_CONTROL_FLOW_ANALYSIS);
		for (const block of cfg.reversePostorder) {
			if (
				fn.blockHandler(block) !== undefined ||
				cfg.loops.some((loop) => loop.header === block)
			)
				continue;
			const incoming = (cfg.predecessors[block] ?? []).filter(
				({ kind }) => kind === "ordinary",
			);
			if (
				incoming.length < 2 ||
				incoming.length !== (cfg.predecessors[block] ?? []).length ||
				new Set(incoming.map(({ from }) => from)).size !== incoming.length
			)
				continue;
			for (const instruction of fn.bodyInstructionIds(block)) {
				const key = expressionKey(fn, instruction);
				if (key === undefined) continue;
				const outputs = fn.instructionResults(instruction);
				const translated = incoming.map((edge) =>
					translatedInputs(
						fn,
						cfg,
						block,
						edge.from,
						{ block, arguments: edge.arguments },
						fn.instructionOperands(instruction),
					),
				);
				if (translated.some((inputs) => inputs === undefined)) continue;
				const available = incoming.map((edge, index) => {
					const expected = expressionKey(fn, instruction, translated[index]);
					for (const candidate of fn.bodyInstructionIds(edge.from)) {
						if (expressionKey(fn, candidate) === expected)
							return fn.instructionResults(candidate)[0];
					}
					return undefined;
				});
				const existing = available.filter((value) => value !== undefined).length;
				if (existing === 0) continue;
				if (
					incoming.some(
						(edge, index) =>
							available[index] === undefined &&
							(cfg.successors[edge.from] ?? []).filter(({ kind }) => kind === "ordinary")
								.length !== 1,
					)
				)
					continue;
				const editor = CoreEditor.open(program, item.function);
				for (const [index, edge] of incoming.entries()) {
					if (available[index] !== undefined) continue;
					available[index] = editor.insertInstruction(
						edge.from,
						fn.blockTerminator(edge.from),
						fn.instructionOpcodeName(instruction),
						translated[index]!,
						{
							attributes: fn.instructionAttributes(instruction),
							outputRepresentations: [fn.valueRepresentation(outputs[0]!)],
							sourcePosition: fn.instructionSourcePosition(instruction),
						},
					).outputs[0];
				}
				const parameter = editor.appendBlockParameter(block, {
					representation: fn.valueRepresentation(outputs[0]!),
				});
				for (const [index, edge] of incoming.entries()) {
					editor.redirectEdge(edge.from, block, {
						block,
						arguments: [...edge.arguments, available[index]!],
					});
				}
				editor.replaceValueUses(outputs[0]!, parameter);
				editor.removeInstruction(instruction);
				return editor.commit();
			}
		}
		return undefined;
	},
};

function proveComparison(
	operator: CoreLoopComparison,
	range: CoreNumericRange,
	bound: number,
): boolean | undefined {
	switch (operator) {
		case "<":
			return range.maximum < bound ? true : range.minimum >= bound ? false : undefined;
		case "<=":
			return range.maximum <= bound ? true : range.minimum > bound ? false : undefined;
		case ">":
			return range.minimum > bound ? true : range.maximum <= bound ? false : undefined;
		case ">=":
			return range.minimum >= bound ? true : range.maximum < bound ? false : undefined;
	}
}

function numberConstant(fn: CoreFunctionStore, value: CoreValueId): number | undefined {
	const definition = fn.valueDefinition(value);
	if (
		definition.kind !== "instruction" ||
		fn.instructionKind(definition.instruction) !== "operation"
	)
		return undefined;
	const opcode = fn.instructionOpcodeName(definition.instruction);
	const attribute = fn.instructionAttributes(definition.instruction).value;
	return (opcode === "createNumber" || opcode === "createF64") &&
		typeof attribute === "number"
		? attribute
		: undefined;
}

function proveRangedInstruction(
	fn: CoreFunctionStore,
	ranges: CoreLoopInductionAnalysis,
	instruction: CoreInstructionId,
	block: CoreBlockId,
): boolean | undefined {
	if (
		fn.instructionKind(instruction) !== "operation" ||
		fn.instructionOpcodeName(instruction) !== "binary"
	)
		return undefined;
	const inputs = fn.instructionOperands(instruction);
	let operator = fn.instructionAttributes(instruction).operator as CoreLoopComparison;
	if (
		!(["<", "<=", ">", ">="] as ReadonlyArray<unknown>).includes(operator) ||
		inputs.length !== 2 ||
		inputs.some(
			(value) => ranges.induction(value)?.comparison?.instruction === instruction,
		)
	)
		return undefined;
	let range = ranges.range(inputs[0]!, block);
	let bound = numberConstant(fn, inputs[1]!);
	if (range === undefined || bound === undefined) {
		range = ranges.range(inputs[1]!, block);
		bound = numberConstant(fn, inputs[0]!);
		operator =
			operator === "<" ? ">" : operator === "<=" ? ">=" : operator === ">" ? "<" : "<=";
	}
	return range === undefined || bound === undefined
		? undefined
		: proveComparison(operator, range, bound);
}

const foldPathComparisons: CorePass = {
	name: "path-range-control-folding",
	stage: "control-flow",
	scope: "block",
	requiredAnalyses: [CORE_LOOP_INDUCTION_ANALYSIS],
	wakesOn: ["body", "cfg", "representations"],
	preserves: [],
	changes: CONTROL_FLOW_CHANGES,
	budget: CONTROL_FLOW_BUDGET,
	run(context) {
		const { program, item } = context;
		if (item.scope !== "block") return undefined;
		const fn = program.function(item.function);
		if (!fn.isBlockLive(item.block)) return undefined;
		const ranges = context.analysis(CORE_LOOP_INDUCTION_ANALYSIS);
		const terminator = fn.terminatorPayload(fn.blockTerminator(item.block));
		if (terminator.kind === "branch") {
			const condition = fn.valueDefinition(terminator.condition);
			const result =
				condition.kind === "instruction"
					? proveRangedInstruction(fn, ranges, condition.instruction, item.block)
					: undefined;
			if (result !== undefined) {
				const editor = CoreEditor.open(program, item.function);
				editor.replaceTerminator(item.block, {
					kind: "jump",
					edge: result ? terminator.consequent : terminator.alternate,
				});
				return editor.commit();
			}
		}
		for (const instruction of fn.bodyInstructionIds(item.block)) {
			const result = proveRangedInstruction(fn, ranges, instruction, item.block);
			if (result === undefined) continue;
			const editor = CoreEditor.open(program, item.function);
			editor.replaceInstruction(instruction, "createBoolean", [], {
				attributes: { value: result },
				sourcePosition: fn.instructionSourcePosition(instruction),
			});
			return editor.commit();
		}
		return undefined;
	},
};

const LOOP_SCALAR_OPERATIONS: ReadonlySet<string> = new Set([
	"move",
	"unary",
	"binary",
	"typeofCompare",
	"rootUse",
]);

const LOOP_SCALAR_CONSUMERS: ReadonlySet<string> = new Set([
	"loadProperty",
	"storeProperty",
	"throwIfTdz",
]);

const LOOP_SCALAR_PRODUCERS: ReadonlySet<string> = new Set([
	"createNumber",
	"createF64",
	"move",
	"unary",
	"binary",
	"typeofCompare",
]);

const selectLoopScalarRepresentations: CorePass = {
	name: "loop-scalar-representation-selection",
	stage: "control-flow",
	scope: "function",
	requiredAnalyses: [
		CORE_EXCEPTION_CONTROL_FLOW_ANALYSIS,
		CORE_LOOP_INDUCTION_ANALYSIS,
		CORE_LOCAL_VALUE_KIND_ANALYSIS,
	],
	wakesOn: ["body", "cfg", "representations"],
	preserves: ["control-flow", "exception-control-flow"],
	changes: { ...CONTROL_FLOW_CHANGES, representations: true },
	budget: CONTROL_FLOW_BUDGET,
	run(context) {
		const { program, item } = context;
		if (item.scope !== "function") return undefined;
		const fn = program.function(item.function);
		const inductions = context.analysis(CORE_LOOP_INDUCTION_ANALYSIS).inductions;
		if (inductions.length === 0) return undefined;
		const cfg = context.analysis(CORE_EXCEPTION_CONTROL_FLOW_ANALYSIS);
		const kinds = context.analysis(CORE_LOCAL_VALUE_KIND_ANALYSIS);
		const inductionValues = new Set(
			inductions.flatMap(({ value, initial, update }) => [value, initial, update]),
		);
		const numeric = (value: CoreValueId): boolean => {
			if (inductionValues.has(value)) return true;
			const scalar = kinds.exactScalar(value);
			return scalar === "number" || scalar === "int32";
		};
		const neighbors = Array.from(
			{ length: fn.valueCapacity },
			() => new Set<CoreValueId>(),
		);
		const connect = (left: CoreValueId, right: CoreValueId): void => {
			neighbors[left]!.add(right);
			neighbors[right]!.add(left);
		};
		for (const block of fn.blockIds()) {
			const incoming = (cfg.predecessors[block] ?? []).filter(
				({ kind }) => kind === "ordinary",
			);
			for (const [index, parameter] of fn.blockParameters(block).entries()) {
				for (const edge of incoming) {
					const argument = edge.arguments[index];
					if (argument !== undefined) connect(parameter.value, argument);
				}
			}
			const handler = fn.blockHandler(block);
			if (handler !== undefined) {
				const parameters = fn.blockParameters(handler.block).slice(1);
				for (const [index, argument] of handler.arguments.entries()) {
					const parameter = parameters[index];
					if (parameter !== undefined) connect(parameter.value, argument);
				}
			}
			for (const instruction of fn.bodyInstructionIds(block)) {
				const opcode = fn.instructionOpcodeName(instruction);
				if (!LOOP_SCALAR_OPERATIONS.has(opcode)) continue;
				const operands = fn.instructionOperands(instruction);
				const results = fn.instructionResults(instruction);
				if (
					opcode === "move" &&
					operands.length === 1 &&
					results.length === 1 &&
					fn.valueRepresentation(operands[0]!) !== fn.valueRepresentation(results[0]!)
				)
					continue;
				const connected = [...operands, ...results].filter(numeric);
				for (let index = 1; index < connected.length; index++) {
					connect(connected[0]!, connected[index]!);
				}
			}
		}
		const selected = new Set<CoreValueId>();
		const pending: Array<CoreValueId> = [];
		const add = (value: CoreValueId): void => {
			if (selected.has(value) || !numeric(value)) return;
			selected.add(value);
			pending.push(value);
		};
		for (const induction of inductions) {
			add(induction.value);
			add(induction.initial);
			add(induction.update);
		}
		for (let cursor = 0; cursor < pending.length; cursor++) {
			for (const neighbor of neighbors[pending[cursor]!]!) add(neighbor);
		}
		for (const value of selected) {
			const definition = fn.valueDefinition(value);
			if (
				definition.kind === "instruction" &&
				!LOOP_SCALAR_PRODUCERS.has(fn.instructionOpcodeName(definition.instruction))
			)
				return undefined;
			for (const { instruction, operand } of fn.uses(value)) {
				if (fn.instructionKind(instruction) !== "operation") continue;
				const opcode = fn.instructionOpcodeName(instruction);
				const builtin = fn.instructionAttributes(instruction).knownBuiltinCall;
				const builtinOperation =
					builtin !== null && typeof builtin === "object" && !Array.isArray(builtin)
						? Object.entries(builtin).find(([key]) => key === "operation")?.[1]
						: undefined;
				const stringCharCodeAtPosition =
					opcode === "call" &&
					operand === 2 &&
					builtinOperation === "String.prototype.charCodeAt";
				if (
					!LOOP_SCALAR_OPERATIONS.has(opcode) &&
					!LOOP_SCALAR_CONSUMERS.has(opcode) &&
					!stringCharCodeAtPosition
				)
					return undefined;
			}
		}
		const representation: CoreRepresentation = [...selected].every(
			(value) => kinds.exactScalar(value) === "int32",
		)
			? "i32"
			: "f64";
		const plannedRepresentation = (value: CoreValueId): CoreRepresentation =>
			selected.has(value) ? representation : fn.valueRepresentation(value);
		for (const block of fn.blockIds()) {
			for (const edge of coreTerminatorEdges(
				fn.terminatorPayload(fn.blockTerminator(block)),
			)) {
				const parameters = fn.blockParameters(edge.block);
				for (const [index, argument] of edge.arguments.entries()) {
					const target = parameters[index];
					if (target === undefined) continue;
					const sourceRepresentation = plannedRepresentation(argument);
					const targetRepresentation = plannedRepresentation(target.value);
					if (
						sourceRepresentation !== targetRepresentation &&
						targetRepresentation !== "boxed" &&
						!(sourceRepresentation === "i32" && targetRepresentation === "f64")
					)
						return undefined;
				}
			}
			const handler = fn.blockHandler(block);
			if (handler === undefined) continue;
			const parameters = fn.blockParameters(handler.block).slice(1);
			for (const [index, argument] of handler.arguments.entries()) {
				const parameter = parameters[index];
				if (
					parameter !== undefined &&
					plannedRepresentation(argument) !== plannedRepresentation(parameter.value)
				)
					return undefined;
			}
		}
		for (const value of selected) {
			const definition = fn.valueDefinition(value);
			if (
				definition.kind === "instruction" &&
				fn.instructionOpcodeName(definition.instruction) === "move"
			) {
				const source = fn.instructionOperands(definition.instruction)[0];
				if (
					source !== undefined &&
					!selected.has(source) &&
					fn.valueRepresentation(source) !== representation
				)
					return undefined;
			}
		}
		const candidates = [...selected].filter(
			(value) => fn.valueRepresentation(value) !== representation,
		);
		if (candidates.length === 0) return undefined;
		const editor = CoreEditor.open(program, item.function);
		for (const value of candidates) editor.setValueRepresentation(value, representation);
		for (const block of fn.blockIds()) {
			let bridged = false;
			const payload = fn.terminatorPayload(fn.blockTerminator(block));
			const replacement = mapTerminatorEdges(payload, (edge) => {
				const parameters = fn.blockParameters(edge.block);
				const arguments_ = edge.arguments.map((argument, index) => {
					const target = parameters[index];
					if (
						target === undefined ||
						plannedRepresentation(argument) === plannedRepresentation(target.value)
					)
						return argument;
					bridged = true;
					return editor.insertInstruction(
						block,
						fn.blockTerminator(block),
						"move",
						[argument],
						{ outputRepresentations: [plannedRepresentation(target.value)] },
					).outputs[0]!;
				});
				return { block: edge.block, arguments: arguments_ };
			});
			if (bridged) editor.replaceTerminator(block, replacement);
		}
		return editor.commit();
	},
};

const reduceBoundedRemainders: CorePass = {
	name: "path-range-strength-reduction",
	stage: "control-flow",
	scope: "block",
	requiredAnalyses: [CORE_LOOP_INDUCTION_ANALYSIS, CORE_LOCAL_VALUE_KIND_ANALYSIS],
	wakesOn: ["body", "cfg", "representations"],
	preserves: [],
	changes: { ...CONTROL_FLOW_CHANGES, cfg: false },
	budget: CONTROL_FLOW_BUDGET,
	run(context) {
		const { program, item } = context;
		if (item.scope !== "block") return undefined;
		const fn = program.function(item.function);
		if (!fn.isBlockLive(item.block)) return undefined;
		const ranges = context.analysis(CORE_LOOP_INDUCTION_ANALYSIS);
		const kinds = context.analysis(CORE_LOCAL_VALUE_KIND_ANALYSIS);
		const numericRepresentation = (value: CoreValueId): "f64" | "i32" | undefined => {
			const representation = fn.valueRepresentation(value);
			if (representation === "f64" || representation === "i32") return representation;
			const scalar = kinds.exactScalar(value);
			return scalar === "int32" ? "i32" : scalar === "number" ? "f64" : undefined;
		};
		for (const instruction of fn.bodyInstructionIds(item.block)) {
			if (
				fn.instructionOpcodeName(instruction) !== "binary" ||
				fn.instructionAttributes(instruction).operator !== "%"
			)
				continue;
			const inputs = fn.instructionOperands(instruction);
			const outputs = fn.instructionResults(instruction);
			if (inputs.length !== 2 || outputs.length !== 1) continue;
			const dividendRepresentation = numericRepresentation(inputs[0]!);
			if (
				dividendRepresentation === undefined ||
				numericRepresentation(inputs[1]!) === undefined ||
				numericRepresentation(outputs[0]!) !== dividendRepresentation
			)
				continue;
			const dividend = ranges.range(inputs[0]!, item.block);
			const divisor = ranges.range(inputs[1]!, item.block);
			if (
				dividend === undefined ||
				divisor === undefined ||
				divisor.minimum !== divisor.maximum ||
				!Number.isSafeInteger(divisor.minimum) ||
				divisor.minimum <= dividend.maximum ||
				dividend.minimum < 0
			)
				continue;
			const editor = CoreEditor.open(program, item.function);
			editor.replaceInstruction(instruction, "move", [inputs[0]!]);
			return editor.commit();
		}
		return undefined;
	},
};

export const CORE_CONTROL_FLOW_PASSES: ReadonlyArray<CorePass> = [
	canonicalizeNaturalLoops,
	hoistLoopInvariants,
	eliminateDominatedRedundancy,
	eliminatePartialRedundancy,
	selectLoopScalarRepresentations,
	foldPathComparisons,
	reduceBoundedRemainders,
];
