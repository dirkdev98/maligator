import { CoreEditor } from "./core-editor.ts";
import { CORE_FUNCTION_HAS_BACKEDGES } from "./core-function-features.ts";
import {
	CORE_CANONICAL_VALUE_ROOTS_ANALYSIS,
	CORE_EXCEPTION_CONTROL_FLOW_ANALYSIS,
} from "./core-ir-control-flow.ts";
import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import { coreInstructionInputsEqual } from "./core-ir-equality.ts";
import { CORE_LOOP_INDUCTION_ANALYSIS } from "./core-ir-loops.ts";
import type {
	CoreLoopComparison,
	CoreLoopInductionAnalysis,
	CoreNumericRange,
} from "./core-ir-loops.ts";
import {
	CoreMemoryLocationTable,
	coreMemoryAccesses,
	coreMemoryLocationFamily,
	coreMemoryLocationIsExact,
} from "./core-ir-memory.ts";
import type { CoreMemoryLocationId } from "./core-ir-memory.ts";
import { coreInstructionEffects } from "./core-ir-opcodes.ts";
import { CORE_LOCAL_FACT_BUNDLE_ANALYSIS } from "./core-ir-provenance.ts";
import type { CoreProvenance } from "./core-ir-provenance.ts";
import { CORE_LOCAL_VALUE_KIND_ANALYSIS } from "./core-ir-value-kinds.ts";
import type {
	CoreBlockId,
	CoreEdge,
	CoreInstructionId,
	CoreMemoryFamily,
	CoreRepresentation,
	CoreTerminatorInput,
	CoreValueId,
} from "./core-ir.ts";
import {
	CORE_MEMORY_FAMILIES,
	CORE_MEMORY_FAMILY_DOMAINS,
	coreBlockId,
	coreInstructionId,
} from "./core-ir.ts";
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

function copyTerminatorEdge(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	offset: number,
): CoreEdge {
	const row = fn.kernel.terminatorEdgeStart(instruction) + offset;
	const argumentStart = fn.kernel.terminatorEdgeArgumentStart(row);
	const argumentCount = fn.kernel.terminatorEdgeArgumentCount(row);
	const arguments_ = new Array<CoreValueId>(argumentCount);
	for (let index = 0; index < argumentCount; index++) {
		arguments_[index] = fn.kernel.operandAt(argumentStart + index);
	}
	return { block: fn.kernel.terminatorEdgeBlock(row), arguments: arguments_ };
}

function mapTerminatorEdges(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	map: (edge: CoreEdge) => CoreEdge,
): CoreTerminatorInput {
	const kernel = fn.kernel;
	const operandStart = kernel.instructionOperandStart(instruction);
	const edgeStart = kernel.terminatorEdgeStart(instruction);
	const edgeCount = kernel.terminatorEdgeCount(instruction);
	switch (fn.instructionKind(instruction)) {
		case "jump":
			return { kind: "jump", edge: map(copyTerminatorEdge(fn, instruction, 0)) };
		case "branch":
			return {
				kind: "branch",
				condition: kernel.operandAt(operandStart),
				consequent: map(copyTerminatorEdge(fn, instruction, 0)),
				alternate: map(copyTerminatorEdge(fn, instruction, 1)),
			};
		case "guard": {
			const fact = kernel.terminatorFact(instruction);
			if (fact === undefined) throw new Error("Malformed Core guard fact");
			return {
				kind: "guard",
				condition: kernel.operandAt(operandStart),
				fact,
				success: map(copyTerminatorEdge(fn, instruction, 0)),
				fallback: map(copyTerminatorEdge(fn, instruction, 1)),
			};
		}
		case "switch": {
			const cases = [];
			for (let offset = 0; offset < edgeCount - 1; offset++) {
				const value = kernel.terminatorEdgeCaseValue(edgeStart + offset);
				if (value === undefined) {
					throw new Error(`Malformed Core switch case ${offset}`);
				}
				cases.push({ value, edge: map(copyTerminatorEdge(fn, instruction, offset)) });
			}
			return {
				kind: "switch",
				discriminant: kernel.operandAt(operandStart),
				cases,
				default: map(copyTerminatorEdge(fn, instruction, edgeCount - 1)),
			};
		}
		case "return":
			return { kind: "return", value: kernel.operandAt(operandStart) };
		case "throw":
			return { kind: "throw", value: kernel.operandAt(operandStart) };
		case "unreachable":
			return { kind: "unreachable" };
		case "operation":
			throw new Error("Expected Core terminator");
	}
}

function instructionOperand(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	index: number,
): CoreValueId | undefined {
	if (index >= fn.kernel.instructionOperandCount(instruction)) return undefined;
	return fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction) + index);
}

function instructionResult(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	index: number,
): CoreValueId | undefined {
	if (index >= fn.kernel.instructionResultCount(instruction)) return undefined;
	return fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction) + index);
}

function copyInstructionOperands(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): Array<CoreValueId> {
	const start = fn.kernel.instructionOperandStart(instruction);
	const count = fn.kernel.instructionOperandCount(instruction);
	const inputs = new Array<CoreValueId>(count);
	for (let index = 0; index < count; index++) {
		inputs[index] = fn.kernel.operandAt(start + index);
	}
	return inputs;
}

function definitionInstruction(
	fn: CoreFunctionStore,
	value: CoreValueId,
): CoreInstructionId | undefined {
	return fn.kernel.valueDefinitionKind(value) === 1
		? coreInstructionId(fn.kernel.valueDefinitionOwner(value))
		: undefined;
}

function definitionBlock(fn: CoreFunctionStore, value: CoreValueId): CoreBlockId {
	const owner = fn.kernel.valueDefinitionOwner(value);
	return fn.kernel.valueDefinitionKind(value) === 1
		? coreBlockId(fn.kernel.instructionBlock(coreInstructionId(owner)))
		: coreBlockId(owner);
}

function blockParameterValues(
	fn: CoreFunctionStore,
	block: CoreBlockId,
): Array<CoreValueId> {
	const start = fn.kernel.blockParameterStart(block);
	const count = fn.kernel.blockParameterCount(block);
	const values = new Array<CoreValueId>(count);
	for (let index = 0; index < count; index++) {
		values[index] = fn.kernel.blockParameterValue(start + index);
	}
	return values;
}

function pureExpressionOpcode(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): number | undefined {
	if (fn.instructionKind(instruction) !== "operation") return undefined;
	const opcode = fn.instructionOpcode(instruction);
	const descriptor = fn.registry.byId(opcode);
	const effects =
		fn.instructionEffectRefinement(instruction)?.effects ?? descriptor.effects;
	const resultCount = fn.kernel.instructionResultCount(instruction);
	if (
		!descriptor.discardable ||
		descriptor.callTransfer !== undefined ||
		resultCount !== 1 ||
		effects.mayThrow ||
		effects.maySuspend ||
		effects.mayGc ||
		effects.callsUserCode ||
		effects.reads.length > 0 ||
		effects.writes.length > 0
	)
		return undefined;
	return opcode;
}

function expressionsEqual(
	fn: CoreFunctionStore,
	left: CoreInstructionId,
	right: CoreInstructionId,
	leftInputs?: ReadonlyArray<CoreValueId>,
	rightInputs?: ReadonlyArray<CoreValueId>,
): boolean {
	if (
		pureExpressionOpcode(fn, left) === undefined ||
		pureExpressionOpcode(fn, right) === undefined ||
		!coreInstructionInputsEqual(fn, left, right, leftInputs, rightInputs)
	)
		return false;
	const leftOutput = fn.kernel.resultAt(fn.kernel.instructionResultStart(left));
	const rightOutput = fn.kernel.resultAt(fn.kernel.instructionResultStart(right));
	return fn.valueRepresentation(leftOutput) === fn.valueRepresentation(rightOutput);
}

function blockParameterSpecs(fn: CoreFunctionStore, block: CoreBlockId) {
	const start = fn.kernel.blockParameterStart(block);
	const count = fn.kernel.blockParameterCount(block);
	const specs: Array<{
		readonly representation: CoreRepresentation;
		readonly role: "value" | "exception";
	}> = [];
	for (let index = 0; index < count; index++) {
		const row = start + index;
		specs.push({
			representation: fn.valueRepresentation(fn.kernel.blockParameterValue(row)),
			role: fn.kernel.blockParameterRole(row) === 1 ? "exception" : "value",
		});
	}
	return specs;
}

const canonicalizeNaturalLoops: CorePass = {
	name: "natural-loop-canonicalization",
	stage: "control-flow",
	scope: "function",
	requiredFunctionFeatures: CORE_FUNCTION_HAS_BACKEDGES,
	requiredAnalyses: [CORE_EXCEPTION_CONTROL_FLOW_ANALYSIS],
	wakesOn: ["cfg", "exceptionFlow"],
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
						fn.kernel.blockHandlerBlock(block) !== undefined ||
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
					mapTerminatorEdges(fn, fn.blockTerminator(source), (edge) =>
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
						arguments: blockParameterValues(fn, preheader),
					},
				});
				return editor.commit();
			}
			const soleLatch = loop.latches.size === 1 ? [...loop.latches][0]! : undefined;
			const soleLatchTerminator =
				soleLatch === undefined ? undefined : fn.blockTerminator(soleLatch);
			if (
				soleLatch === undefined ||
				soleLatchTerminator === undefined ||
				fn.instructionKind(soleLatchTerminator) !== "jump" ||
				fn.kernel.terminatorEdgeBlock(
					fn.kernel.terminatorEdgeStart(soleLatchTerminator),
				) !== loop.header ||
				(cfg.successors[soleLatch] ?? []).length !== 1
			) {
				const editor = CoreEditor.open(program, item.function);
				const latch = editor.createBlock(blockParameterSpecs(fn, loop.header));
				for (const source of loop.latches) redirect(editor, source, loop.header, latch);
				editor.setTerminator(latch, {
					kind: "jump",
					edge: {
						block: loop.header,
						arguments: blockParameterValues(fn, latch),
					},
				});
				return editor.commit();
			}
			const exit = loop.exits.find(({ dedicated }) => !dedicated);
			if (exit !== undefined) {
				const parameterStart = fn.kernel.blockParameterStart(exit.to);
				const parameterCount = fn.kernel.blockParameterCount(exit.to);
				let hasExceptionParameter = false;
				for (let index = 0; index < parameterCount; index++) {
					if (fn.kernel.blockParameterRole(parameterStart + index) === 1) {
						hasExceptionParameter = true;
						break;
					}
				}
				if (hasExceptionParameter) continue;
				const editor = CoreEditor.open(program, item.function);
				const dedicated = editor.createBlock(blockParameterSpecs(fn, exit.to));
				redirect(editor, exit.from, exit.to, dedicated);
				editor.setTerminator(dedicated, {
					kind: "jump",
					edge: {
						block: exit.to,
						arguments: blockParameterValues(fn, dedicated),
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
	readonly locations: CoreMemoryLocationTable;
	readonly partitions: ReadonlyMap<CoreMemoryFamily, ReadonlySet<CoreMemoryLocationId>>;
}

function summarizeLoopWrites(
	fn: CoreFunctionStore,
	loopBlocks: ReadonlySet<CoreBlockId>,
): CoreLoopWriteSummary {
	const opaque = new Set<CoreMemoryFamily>();
	const inexact = new Set<CoreMemoryFamily>();
	const locations = new CoreMemoryLocationTable();
	const partitions = new Map<CoreMemoryFamily, Set<CoreMemoryLocationId>>();
	for (const block of loopBlocks) {
		const terminator = fn.blockTerminator(block);
		for (
			let cursor = fn.kernel.blockFirstInstruction(block);
			cursor >= 0 && cursor !== terminator;
			cursor = fn.kernel.instructionNext(coreInstructionId(cursor))
		) {
			const instruction = coreInstructionId(cursor);
			const effects = coreInstructionEffects(fn, instruction);
			if (effects.callsUserCode || effects.maySuspend) {
				for (const family of CORE_MEMORY_FAMILIES) opaque.add(family);
			}
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
					familyPartitions.add(locations.id(write.location));
					partitions.set(family, familyPartitions);
				}
			}
		}
	}
	return { opaque, inexact, locations, partitions };
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
		if (writes.partitions.get(family)?.has(writes.locations.id(read.location))) {
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
	const base = instructionOperand(fn, instruction, 0);
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
	requiredFunctionFeatures: CORE_FUNCTION_HAS_BACKEDGES,
	requiredAnalyses: [
		CORE_EXCEPTION_CONTROL_FLOW_ANALYSIS,
		CORE_LOCAL_FACT_BUNDLE_ANALYSIS,
	],
	wakesOn: ["body", "cfg", "exceptionFlow", "memoryEffects"],
	changes: { ...CONTROL_FLOW_CHANGES, cfg: false, facts: true },
	budget: CONTROL_FLOW_BUDGET,
	run(context) {
		const { program, item } = context;
		if (item.scope !== "function") return undefined;
		const fn = program.function(item.function);
		const cfg = context.analysis(CORE_EXCEPTION_CONTROL_FLOW_ANALYSIS);
		const provenance = context.analysis(CORE_LOCAL_FACT_BUNDLE_ANALYSIS).provenance;
		const moves: Array<{
			readonly instruction: CoreInstructionId;
			readonly preheader: CoreBlockId;
		}> = [];
		const selected = new Set<CoreInstructionId>();
		for (const loop of [...cfg.loops].sort((left, right) => right.depth - left.depth)) {
			if (!loop.canonical || loop.preheader === undefined) continue;
			const loopWrites = summarizeLoopWrites(fn, loop.blocks);
			for (const block of loop.blocks) {
				const terminator = fn.blockTerminator(block);
				for (
					let cursor = fn.kernel.blockFirstInstruction(block);
					cursor >= 0 && cursor !== terminator;
					cursor = fn.kernel.instructionNext(coreInstructionId(cursor))
				) {
					const instruction = coreInstructionId(cursor);
					if (selected.has(instruction)) continue;
					if (fn.instructionKind(instruction) !== "operation") continue;
					const descriptor = fn.registry.byId(fn.instructionOpcode(instruction));
					const effects = coreInstructionEffects(fn, instruction);
					const containedArrayLength = isContainedArrayLengthRead(
						fn,
						provenance,
						instruction,
					);
					const operandStart = fn.kernel.instructionOperandStart(instruction);
					const operandCount = fn.kernel.instructionOperandCount(instruction);
					let inputDefinedInLoop = false;
					for (let index = 0; index < operandCount; index++) {
						if (
							loop.blocks.has(
								definitionBlock(fn, fn.kernel.operandAt(operandStart + index)),
							)
						) {
							inputDefinedInLoop = true;
							break;
						}
					}
					if (
						(!containedArrayLength &&
							(!descriptor.discardable ||
								effects.mayThrow ||
								effects.maySuspend ||
								effects.mayGc ||
								effects.callsUserCode ||
								effects.writes.length > 0)) ||
						inputDefinedInLoop ||
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
	changes: { ...CONTROL_FLOW_CHANGES, cfg: false, facts: true },
	budget: CONTROL_FLOW_BUDGET,
	run(context) {
		const { program, item } = context;
		if (item.scope !== "function") return undefined;
		const fn = program.function(item.function);
		const cfg = context.analysis(CORE_EXCEPTION_CONTROL_FLOW_ANALYSIS);
		const roots = context.analysis(CORE_CANONICAL_VALUE_ROOTS_ANALYSIS);
		type AvailableExpression = {
			readonly instruction: CoreInstructionId;
			readonly inputs: ReadonlyArray<CoreValueId>;
			readonly value: CoreValueId;
		};
		const available = new Array<Map<number, Array<AvailableExpression>>>(
			fn.blockCapacity,
		);
		const replacements = new Map<CoreInstructionId, CoreValueId>();
		for (const block of cfg.reversePostorder) {
			const parent = cfg.immediateDominators[block];
			const current = new Map(
				parent === null || parent === undefined ? [] : available[parent],
			);
			const terminator = fn.blockTerminator(block);
			for (
				let cursor = fn.kernel.blockFirstInstruction(block);
				cursor >= 0 && cursor !== terminator;
				cursor = fn.kernel.instructionNext(coreInstructionId(cursor))
			) {
				const instruction = coreInstructionId(cursor);
				const inputStart = fn.kernel.instructionOperandStart(instruction);
				const inputCount = fn.kernel.instructionOperandCount(instruction);
				const rooted = new Array<CoreValueId>(inputCount);
				for (let index = 0; index < inputCount; index++) {
					const value = fn.kernel.operandAt(inputStart + index);
					rooted[index] = roots.get(value) ?? value;
				}
				const opcode = pureExpressionOpcode(fn, instruction);
				if (opcode === undefined) continue;
				const bucket = current.get(opcode) ?? [];
				const existingIndex = bucket.findIndex((candidate) =>
					expressionsEqual(
						fn,
						instruction,
						candidate.instruction,
						rooted,
						candidate.inputs,
					),
				);
				const existing = bucket[existingIndex];
				const existingBlock =
					existing === undefined ? undefined : definitionBlock(fn, existing.value);
				if (
					existing === undefined ||
					existingBlock === undefined ||
					(existingBlock !== block &&
						!cfg.instructionDominatesBlock(existingBlock, block))
				) {
					const next = [...bucket];
					const entry = {
						instruction,
						inputs: rooted,
						value: instructionResult(fn, instruction, 0)!,
					};
					if (existingIndex < 0) next.push(entry);
					else next[existingIndex] = entry;
					current.set(opcode, next);
				} else replacements.set(instruction, existing.value);
			}
			available[block] = current;
		}
		if (replacements.size === 0) return undefined;
		const editor = CoreEditor.open(program, item.function);
		for (const [instruction, replacement] of replacements) {
			if (!fn.isInstructionLive(instruction)) continue;
			const result = instructionResult(fn, instruction, 0);
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
	const parameterStart = fn.kernel.blockParameterStart(block);
	const parameterCount = fn.kernel.blockParameterCount(block);
	const translated: Array<CoreValueId> = [];
	for (const input of inputs) {
		let parameter = -1;
		for (let index = 0; index < parameterCount; index++) {
			if (fn.kernel.blockParameterValue(parameterStart + index) === input) {
				parameter = index;
				break;
			}
		}
		if (parameter >= 0) {
			const value = edge.arguments[parameter];
			if (value === undefined) return undefined;
			translated.push(value);
			continue;
		}
		const inputBlock = definitionBlock(fn, input);
		if (inputBlock === block || !cfg.instructionDominatesBlock(inputBlock, predecessor))
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
	changes: { ...CONTROL_FLOW_CHANGES, facts: true },
	budget: CONTROL_FLOW_BUDGET,
	run(context) {
		const { program, item } = context;
		if (item.scope !== "function") return undefined;
		const fn = program.function(item.function);
		const cfg = context.analysis(CORE_EXCEPTION_CONTROL_FLOW_ANALYSIS);
		for (const block of cfg.reversePostorder) {
			if (
				fn.kernel.blockHandlerBlock(block) !== undefined ||
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
			const terminator = fn.blockTerminator(block);
			for (
				let cursor = fn.kernel.blockFirstInstruction(block);
				cursor >= 0 && cursor !== terminator;
				cursor = fn.kernel.instructionNext(coreInstructionId(cursor))
			) {
				const instruction = coreInstructionId(cursor);
				const opcode = pureExpressionOpcode(fn, instruction);
				if (opcode === undefined) continue;
				const output = instructionResult(fn, instruction, 0)!;
				const inputs = copyInstructionOperands(fn, instruction);
				const translated = incoming.map((edge) =>
					translatedInputs(
						fn,
						cfg,
						block,
						edge.from,
						{ block, arguments: edge.arguments },
						inputs,
					),
				);
				if (translated.some((inputs) => inputs === undefined)) continue;
				const available = incoming.map((edge, index) => {
					const candidateTerminator = fn.blockTerminator(edge.from);
					for (
						let candidateCursor = fn.kernel.blockFirstInstruction(edge.from);
						candidateCursor >= 0 && candidateCursor !== candidateTerminator;
						candidateCursor = fn.kernel.instructionNext(
							coreInstructionId(candidateCursor),
						)
					) {
						const candidate = coreInstructionId(candidateCursor);
						if (
							fn.instructionOpcode(candidate) === opcode &&
							expressionsEqual(fn, instruction, candidate, translated[index])
						)
							return instructionResult(fn, candidate, 0);
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
							outputRepresentations: [fn.valueRepresentation(output)],
							sourcePosition: fn.instructionSourcePosition(instruction),
						},
					).outputs[0];
				}
				const parameter = editor.appendBlockParameter(block, {
					representation: fn.valueRepresentation(output),
				});
				for (const [index, edge] of incoming.entries()) {
					editor.redirectEdge(edge.from, block, {
						block,
						arguments: [...edge.arguments, available[index]!],
					});
				}
				editor.replaceValueUses(output, parameter);
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
	const instruction = definitionInstruction(fn, value);
	if (instruction === undefined || fn.instructionKind(instruction) !== "operation")
		return undefined;
	const opcode = fn.instructionOpcodeName(instruction);
	const attribute = fn.instructionAttributes(instruction).value;
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
	const inputCount = fn.kernel.instructionOperandCount(instruction);
	const first = instructionOperand(fn, instruction, 0);
	const second = instructionOperand(fn, instruction, 1);
	let operator = fn.instructionAttributes(instruction).operator as CoreLoopComparison;
	if (
		!(["<", "<=", ">", ">="] as ReadonlyArray<unknown>).includes(operator) ||
		inputCount !== 2 ||
		first === undefined ||
		second === undefined ||
		ranges.induction(first)?.comparison?.instruction === instruction ||
		ranges.induction(second)?.comparison?.instruction === instruction
	)
		return undefined;
	let range = ranges.range(first, block);
	let bound = numberConstant(fn, second);
	if (range === undefined || bound === undefined) {
		range = ranges.range(second, block);
		bound = numberConstant(fn, first);
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
	scope: "function",
	requiredAnalyses: [CORE_LOOP_INDUCTION_ANALYSIS],
	wakesOn: ["body", "cfg", "representations"],
	changes: CONTROL_FLOW_CHANGES,
	budget: CONTROL_FLOW_BUDGET,
	run(context) {
		const { program, item } = context;
		if (item.scope !== "function") return undefined;
		const fn = program.function(item.function);
		const ranges = context.analysis(CORE_LOOP_INDUCTION_ANALYSIS);
		let editor: CoreEditor | undefined;
		for (const block of fn.blockIds()) {
			const terminator = fn.blockTerminator(block);
			if (fn.instructionKind(terminator) === "branch") {
				const condition = definitionInstruction(
					fn,
					fn.kernel.operandAt(fn.kernel.instructionOperandStart(terminator)),
				);
				const result =
					condition === undefined
						? undefined
						: proveRangedInstruction(fn, ranges, condition, block);
				if (result !== undefined) {
					editor ??= CoreEditor.open(program, item.function);
					editor.replaceTerminator(block, {
						kind: "jump",
						edge: copyTerminatorEdge(fn, terminator, result ? 0 : 1),
					});
					continue;
				}
			}
			for (
				let cursor = fn.kernel.blockFirstInstruction(block);
				cursor >= 0 && cursor !== terminator;
				cursor = fn.kernel.instructionNext(coreInstructionId(cursor))
			) {
				const instruction = coreInstructionId(cursor);
				const result = proveRangedInstruction(fn, ranges, instruction, block);
				if (result === undefined) continue;
				editor ??= CoreEditor.open(program, item.function);
				editor.replaceInstruction(instruction, "createBoolean", [], {
					attributes: { value: result },
					sourcePosition: fn.instructionSourcePosition(instruction),
				});
				break;
			}
		}
		return editor?.commit();
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
	requiredFunctionFeatures: CORE_FUNCTION_HAS_BACKEDGES,
	requiredAnalyses: [
		CORE_EXCEPTION_CONTROL_FLOW_ANALYSIS,
		CORE_LOOP_INDUCTION_ANALYSIS,
		CORE_LOCAL_VALUE_KIND_ANALYSIS,
	],
	wakesOn: ["body", "cfg", "representations"],
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
		for (let blockIndex = 0; blockIndex < fn.blockCapacity; blockIndex++) {
			const block = coreBlockId(blockIndex);
			if (fn.kernel.blockLive(block) === 0) continue;
			const incoming = (cfg.predecessors[block] ?? []).filter(
				({ kind }) => kind === "ordinary",
			);
			const parameterStart = fn.kernel.blockParameterStart(block);
			const parameterCount = fn.kernel.blockParameterCount(block);
			for (let index = 0; index < parameterCount; index++) {
				const parameter = fn.kernel.blockParameterValue(parameterStart + index);
				for (const edge of incoming) {
					const argument = edge.arguments[index];
					if (argument !== undefined) connect(parameter, argument);
				}
			}
			const handlerBlock = fn.kernel.blockHandlerBlock(block);
			if (handlerBlock !== undefined) {
				const handlerParameterStart = fn.kernel.blockParameterStart(handlerBlock);
				const handlerParameterCount = fn.kernel.blockParameterCount(handlerBlock);
				const argumentStart = fn.kernel.blockHandlerArgumentStart(block);
				const argumentCount = fn.kernel.blockHandlerArgumentCount(block);
				for (let index = 0; index < argumentCount; index++) {
					if (index + 1 < handlerParameterCount) {
						connect(
							fn.kernel.blockParameterValue(handlerParameterStart + index + 1),
							fn.kernel.handlerArgumentAt(argumentStart + index),
						);
					}
				}
			}
			const terminator = fn.blockTerminator(block);
			for (
				let cursor = fn.kernel.blockFirstInstruction(block);
				cursor >= 0 && cursor !== terminator;
				cursor = fn.kernel.instructionNext(coreInstructionId(cursor))
			) {
				const instruction = coreInstructionId(cursor);
				const opcode = fn.instructionOpcodeName(instruction);
				if (!LOOP_SCALAR_OPERATIONS.has(opcode)) continue;
				const operandStart = fn.kernel.instructionOperandStart(instruction);
				const operandCount = fn.kernel.instructionOperandCount(instruction);
				const resultStart = fn.kernel.instructionResultStart(instruction);
				const resultCount = fn.kernel.instructionResultCount(instruction);
				if (
					opcode === "move" &&
					operandCount === 1 &&
					resultCount === 1 &&
					fn.valueRepresentation(fn.kernel.operandAt(operandStart)) !==
						fn.valueRepresentation(fn.kernel.resultAt(resultStart))
				)
					continue;
				let firstConnected: CoreValueId | undefined;
				for (let index = 0; index < operandCount + resultCount; index++) {
					const value =
						index < operandCount
							? fn.kernel.operandAt(operandStart + index)
							: fn.kernel.resultAt(resultStart + index - operandCount);
					if (!numeric(value)) continue;
					if (firstConnected === undefined) firstConnected = value;
					else connect(firstConnected, value);
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
			const definition = definitionInstruction(fn, value);
			if (
				definition !== undefined &&
				!LOOP_SCALAR_PRODUCERS.has(fn.instructionOpcodeName(definition))
			)
				return undefined;
			for (
				let use = fn.kernel.valueFirstUse(value);
				use >= 0;
				use = fn.kernel.useNext(use)
			) {
				const instruction = fn.kernel.useInstruction(use);
				const operand = fn.kernel.useOperand(use);
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
		for (let blockIndex = 0; blockIndex < fn.blockCapacity; blockIndex++) {
			const block = coreBlockId(blockIndex);
			if (fn.kernel.blockLive(block) === 0) continue;
			const terminator = fn.blockTerminator(block);
			const edgeStart = fn.kernel.terminatorEdgeStart(terminator);
			const edgeCount = fn.kernel.terminatorEdgeCount(terminator);
			for (let edgeOffset = 0; edgeOffset < edgeCount; edgeOffset++) {
				const edgeRow = edgeStart + edgeOffset;
				const targetBlock = fn.kernel.terminatorEdgeBlock(edgeRow);
				const targetStart = fn.kernel.blockParameterStart(targetBlock);
				const targetCount = fn.kernel.blockParameterCount(targetBlock);
				const argumentStart = fn.kernel.terminatorEdgeArgumentStart(edgeRow);
				const argumentCount = fn.kernel.terminatorEdgeArgumentCount(edgeRow);
				for (let index = 0; index < argumentCount; index++) {
					if (index >= targetCount) continue;
					const argument = fn.kernel.operandAt(argumentStart + index);
					const target = fn.kernel.blockParameterValue(targetStart + index);
					const sourceRepresentation = plannedRepresentation(argument);
					const targetRepresentation = plannedRepresentation(target);
					if (
						sourceRepresentation !== targetRepresentation &&
						targetRepresentation !== "boxed" &&
						!(sourceRepresentation === "i32" && targetRepresentation === "f64")
					)
						return undefined;
				}
			}
			const handlerBlock = fn.kernel.blockHandlerBlock(block);
			if (handlerBlock === undefined) continue;
			const parameterStart = fn.kernel.blockParameterStart(handlerBlock);
			const parameterCount = fn.kernel.blockParameterCount(handlerBlock);
			const argumentStart = fn.kernel.blockHandlerArgumentStart(block);
			const argumentCount = fn.kernel.blockHandlerArgumentCount(block);
			for (let index = 0; index < argumentCount; index++) {
				const argument = fn.kernel.handlerArgumentAt(argumentStart + index);
				if (
					index + 1 < parameterCount &&
					plannedRepresentation(argument) !==
						plannedRepresentation(
							fn.kernel.blockParameterValue(parameterStart + index + 1),
						)
				)
					return undefined;
			}
		}
		for (const value of selected) {
			const definition = definitionInstruction(fn, value);
			if (definition !== undefined && fn.instructionOpcodeName(definition) === "move") {
				const source = instructionOperand(fn, definition, 0);
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
		for (let blockIndex = 0; blockIndex < fn.blockCapacity; blockIndex++) {
			const block = coreBlockId(blockIndex);
			if (fn.kernel.blockLive(block) === 0) continue;
			let bridged = false;
			const terminator = fn.blockTerminator(block);
			const replacement = mapTerminatorEdges(fn, terminator, (edge) => {
				const parameterStart = fn.kernel.blockParameterStart(edge.block);
				const parameterCount = fn.kernel.blockParameterCount(edge.block);
				const arguments_ = edge.arguments.map((argument, index) => {
					const target =
						index < parameterCount
							? fn.kernel.blockParameterValue(parameterStart + index)
							: undefined;
					if (
						target === undefined ||
						plannedRepresentation(argument) === plannedRepresentation(target)
					)
						return argument;
					bridged = true;
					return editor.insertInstruction(
						block,
						fn.blockTerminator(block),
						"move",
						[argument],
						{ outputRepresentations: [plannedRepresentation(target)] },
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
	scope: "function",
	requiredAnalyses: [CORE_LOOP_INDUCTION_ANALYSIS, CORE_LOCAL_VALUE_KIND_ANALYSIS],
	wakesOn: ["body", "cfg", "representations"],
	changes: { ...CONTROL_FLOW_CHANGES, cfg: false },
	budget: CONTROL_FLOW_BUDGET,
	run(context) {
		const { program, item } = context;
		if (item.scope !== "function") return undefined;
		const fn = program.function(item.function);
		const ranges = context.analysis(CORE_LOOP_INDUCTION_ANALYSIS);
		const kinds = context.analysis(CORE_LOCAL_VALUE_KIND_ANALYSIS);
		const numericRepresentation = (value: CoreValueId): "f64" | "i32" | undefined => {
			const representation = fn.valueRepresentation(value);
			if (representation === "f64" || representation === "i32") return representation;
			const scalar = kinds.exactScalar(value);
			return scalar === "int32" ? "i32" : scalar === "number" ? "f64" : undefined;
		};
		let editor: CoreEditor | undefined;
		for (const block of fn.blockIds()) {
			const terminator = fn.blockTerminator(block);
			for (
				let cursor = fn.kernel.blockFirstInstruction(block);
				cursor >= 0 && cursor !== terminator;
				cursor = fn.kernel.instructionNext(coreInstructionId(cursor))
			) {
				const instruction = coreInstructionId(cursor);
				if (
					fn.instructionOpcodeName(instruction) !== "binary" ||
					fn.instructionAttributes(instruction).operator !== "%"
				)
					continue;
				if (
					fn.kernel.instructionOperandCount(instruction) !== 2 ||
					fn.kernel.instructionResultCount(instruction) !== 1
				)
					continue;
				const dividendValue = instructionOperand(fn, instruction, 0)!;
				const divisorValue = instructionOperand(fn, instruction, 1)!;
				const output = instructionResult(fn, instruction, 0)!;
				const dividendRepresentation = numericRepresentation(dividendValue);
				if (
					dividendRepresentation === undefined ||
					numericRepresentation(divisorValue) === undefined ||
					numericRepresentation(output) !== dividendRepresentation
				)
					continue;
				const dividend = ranges.range(dividendValue, block);
				const divisor = ranges.range(divisorValue, block);
				if (
					dividend === undefined ||
					divisor === undefined ||
					divisor.minimum !== divisor.maximum ||
					!Number.isSafeInteger(divisor.minimum) ||
					divisor.minimum <= dividend.maximum ||
					dividend.minimum < 0
				)
					continue;
				editor ??= CoreEditor.open(program, item.function);
				editor.replaceInstruction(instruction, "move", [dividendValue]);
			}
		}
		return editor?.commit();
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
