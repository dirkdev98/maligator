import { compilerIntegerRangeIsInt32 } from "../shared/integer-range.ts";
import type { CompilerIntegerRange } from "../shared/integer-range.ts";
import { CoreEditor } from "./core-editor.ts";
import { CORE_FUNCTION_HAS_BACKEDGES } from "./core-function-features.ts";
import {
	CORE_CANONICAL_VALUE_ROOTS_ANALYSIS,
	CORE_CONTROL_FLOW_BUNDLE_ANALYSIS,
} from "./core-ir-control-flow.ts";
import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import {
	coreInstructionInputsEqual,
	coreInstructionInputsHash,
} from "./core-ir-equality.ts";
import { CORE_LOOP_INDUCTION_ANALYSIS } from "./core-ir-loops.ts";
import type { CoreLoopComparison, CoreLoopInductionAnalysis } from "./core-ir-loops.ts";
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
import {
	CORE_LOCAL_VALUE_KIND_ANALYSIS,
	corePrivateArrayLengthCandidates,
} from "./core-ir-value-kinds.ts";
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
	coreRepresentationCanWiden,
} from "./core-ir.ts";
import { CORE_O2_PASS_BUDGETS } from "./core-optimization-families.ts";
import type { CoreFunctionPass } from "./core-pass.ts";
import { cacheStablePrivateReads } from "./core-private-read-caching.ts";
import type { CoreFunctionStore } from "./core-store.ts";

const CONTROL_FLOW_BUDGET = CORE_O2_PASS_BUDGETS["cfg-loop-licm-pre"];

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

function ordinaryPredecessorCounts(fn: CoreFunctionStore): Uint32Array {
	const counts = new Uint32Array(fn.blockCapacity);
	for (const block of fn.blockIds()) {
		const terminator = fn.blockTerminator(block);
		const edgeStart = fn.kernel.terminatorEdgeStart(terminator);
		const edgeCount = fn.kernel.terminatorEdgeCount(terminator);
		for (let index = 0; index < edgeCount; index++) {
			counts[fn.kernel.terminatorEdgeBlock(edgeStart + index)]!++;
		}
	}
	return counts;
}

function hasLoopNormalizationConsumer(fn: CoreFunctionStore): boolean {
	const predecessorCounts = ordinaryPredecessorCounts(fn);
	for (const block of fn.blockIds()) {
		if (predecessorCounts[block]! > 1) return true;
		if (fn.instructionKind(fn.blockTerminator(block)) !== "jump") return true;
	}
	return false;
}

function hasLoopInvariantConsumer(fn: CoreFunctionStore): boolean {
	for (const instruction of fn.instructionIds()) {
		if (
			pureExpressionOpcode(fn, instruction) !== undefined ||
			(fn.instructionKind(instruction) === "operation" &&
				fn.instructionOpcodeName(instruction) === "loadPropertyStatic")
		)
			return true;
	}
	return false;
}

function hasRepeatedPureExpressionAcrossBlocks(fn: CoreFunctionStore): boolean {
	const firstBlockByOpcode = new Map<number, CoreBlockId>();
	for (const block of fn.blockIds()) {
		for (const instruction of fn.bodyInstructionIds(block)) {
			const opcode = pureExpressionOpcode(fn, instruction);
			if (opcode === undefined) continue;
			const firstBlock = firstBlockByOpcode.get(opcode);
			if (firstBlock !== undefined && firstBlock !== block) return true;
			firstBlockByOpcode.set(opcode, block);
		}
	}
	return false;
}

function hasPartialRedundancyConsumer(fn: CoreFunctionStore): boolean {
	const expressionsByBlock = Array.from(
		{ length: fn.blockCapacity },
		() => new Set<number>(),
	);
	const predecessors = Array.from(
		{ length: fn.blockCapacity },
		() => new Set<CoreBlockId>(),
	);
	for (const block of fn.blockIds()) {
		for (const instruction of fn.bodyInstructionIds(block)) {
			const opcode = pureExpressionOpcode(fn, instruction);
			if (opcode !== undefined) expressionsByBlock[block]!.add(opcode);
		}
		const terminator = fn.blockTerminator(block);
		const edgeStart = fn.kernel.terminatorEdgeStart(terminator);
		const edgeCount = fn.kernel.terminatorEdgeCount(terminator);
		for (let index = 0; index < edgeCount; index++) {
			predecessors[fn.kernel.terminatorEdgeBlock(edgeStart + index)]!.add(block);
		}
	}
	for (const block of fn.blockIds()) {
		if (predecessors[block]!.size < 2 || expressionsByBlock[block]!.size === 0) continue;
		for (const predecessor of predecessors[block]!) {
			for (const opcode of expressionsByBlock[block]!) {
				if (expressionsByBlock[predecessor]!.has(opcode)) return true;
			}
		}
	}
	return false;
}

function hasRelationalConstantComparison(fn: CoreFunctionStore): boolean {
	for (const instruction of fn.instructionIds()) {
		if (
			fn.instructionKind(instruction) !== "operation" ||
			fn.instructionOpcodeName(instruction) !== "binary"
		)
			continue;
		const operator = fn.instructionAttributes(instruction).operator;
		if (operator !== "<" && operator !== "<=" && operator !== ">" && operator !== ">=")
			continue;
		const first = instructionOperand(fn, instruction, 0);
		const second = instructionOperand(fn, instruction, 1);
		if (
			(first !== undefined && numberConstant(fn, first) !== undefined) ||
			(second !== undefined && numberConstant(fn, second) !== undefined)
		)
			return true;
	}
	return false;
}

function hasLoopScalarRepresentationConsumer(fn: CoreFunctionStore): boolean {
	let numericParameter = false;
	for (const block of fn.blockIds()) {
		const start = fn.kernel.blockParameterStart(block);
		const count = fn.kernel.blockParameterCount(block);
		for (let index = 0; index < count; index++) {
			const representation = fn.valueRepresentation(
				fn.kernel.blockParameterValue(start + index),
			);
			if (representation === "boxed" || representation === "f64") {
				numericParameter = true;
				break;
			}
		}
		if (numericParameter) break;
	}
	if (!numericParameter) return false;
	for (const instruction of fn.instructionIds()) {
		const header = fn.instructionHeader(instruction);
		if (typeof header === "string") continue;
		const opcode = header.opcode;
		const operator = fn.instructionAttributes(instruction).operator;
		if (
			(opcode === "binary" && (operator === "+" || operator === "-")) ||
			(opcode === "unary" && (operator === "increment" || operator === "decrement"))
		)
			return true;
	}
	return false;
}

function hasRemainderStrengthReductionConsumer(fn: CoreFunctionStore): boolean {
	for (const instruction of fn.instructionIds()) {
		if (
			fn.instructionKind(instruction) === "operation" &&
			fn.instructionOpcodeName(instruction) === "binary" &&
			fn.instructionAttributes(instruction).operator === "%"
		)
			return true;
	}
	return false;
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

const canonicalizeNaturalLoops: CoreFunctionPass = {
	name: "natural-loop-canonicalization",
	stage: "control-flow",
	requiredFunctionFeatures: CORE_FUNCTION_HAS_BACKEDGES,
	admission: {
		predicate: "cyclic control flow with a multi-predecessor block or non-jump latch",
		hasOpportunity({ program, function: functionId }) {
			return hasLoopNormalizationConsumer(program.function(functionId));
		},
	},
	requiredAnalyses: [CORE_CONTROL_FLOW_BUNDLE_ANALYSIS],
	wakesOn: ["cfg", "exceptionFlow"],
	changes: CONTROL_FLOW_CHANGES,
	budget: CONTROL_FLOW_BUDGET,
	run(context) {
		const { program, item } = context;
		const fn = program.function(item.function);
		const cfg = context.analysis(CORE_CONTROL_FLOW_BUNDLE_ANALYSIS).exceptional();
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

const hoistLoopInvariants: CoreFunctionPass = {
	name: "loop-invariant-code-motion",
	stage: "control-flow",
	requiredFunctionFeatures: CORE_FUNCTION_HAS_BACKEDGES,
	admission: {
		predicate: "cyclic control flow with a pure expression or static property read",
		hasOpportunity({ program, function: functionId }) {
			return hasLoopInvariantConsumer(program.function(functionId));
		},
	},
	requiredAnalyses: [CORE_CONTROL_FLOW_BUNDLE_ANALYSIS, CORE_LOCAL_FACT_BUNDLE_ANALYSIS],
	wakesOn: ["body", "cfg", "exceptionFlow", "memoryEffects", "representations"],
	changes: { ...CONTROL_FLOW_CHANGES, cfg: false, facts: true },
	budget: CONTROL_FLOW_BUDGET,
	run(context) {
		const { program, item } = context;
		const fn = program.function(item.function);
		const cfg = context.analysis(CORE_CONTROL_FLOW_BUNDLE_ANALYSIS).exceptional();
		const provenance = context.analysis(CORE_LOCAL_FACT_BUNDLE_ANALYSIS).provenance;
		const privateArrays = corePrivateArrayLengthCandidates(
			program,
			fn,
			cfg,
			context.compilationContext,
		);
		const privateArrayByLengthLoad = new Map(
			privateArrays.flatMap((array) =>
				array.lengthLoads.map((instruction) => [instruction, array] as const),
			),
		);
		const lengthProofs = [...privateArrayByLengthLoad.keys()]
			.filter(
				(instruction) => fn.instructionAttributes(instruction).exactArrayLength !== true,
			)
			.slice(0, context.remainingEdits);
		const moveBudget = context.remainingEdits - lengthProofs.length;
		const moves: Array<{
			readonly instruction: CoreInstructionId;
			readonly preheader: CoreBlockId;
		}> = [];
		const selected = new Set<CoreInstructionId>();
		for (const loop of [...cfg.loops].sort((left, right) => right.depth - left.depth)) {
			if (moves.length >= moveBudget) break;
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
					const privateArray = privateArrayByLengthLoad.get(instruction);
					const stablePrivateArrayLength =
						privateArray !== undefined &&
						cfg.dominates(fn.instructionBlock(privateArray.allocation), loop.preheader) &&
						privateArray.elementStores.every(
							(store) => !loop.blocks.has(fn.instructionBlock(store)),
						);
					const containedArrayLength =
						stablePrivateArrayLength ||
						isContainedArrayLengthRead(fn, provenance, instruction);
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
					if (moves.length >= moveBudget) break;
				}
				if (moves.length >= moveBudget) break;
			}
			if (moves.length >= moveBudget) break;
		}
		if (moves.length === 0 && lengthProofs.length === 0) return undefined;
		const editor = CoreEditor.open(program, item.function);
		for (const instruction of lengthProofs) {
			editor.replaceInstruction(
				instruction,
				"loadPropertyStatic",
				[instructionOperand(fn, instruction, 0)!],
				{
					attributes: {
						...fn.instructionAttributes(instruction),
						exactArrayLength: true,
					},
					sourcePosition: fn.instructionSourcePosition(instruction),
					effectRefinement: fn.instructionEffectRefinement(instruction),
				},
			);
		}
		for (const { instruction, preheader } of moves) {
			editor.moveInstruction(instruction, preheader);
		}
		return editor.commit();
	},
};

const eliminateDominatedRedundancy: CoreFunctionPass = {
	name: "dominance-redundancy-elimination",
	stage: "control-flow",
	admission: {
		predicate: "repeated pure expression opcode across distinct blocks",
		hasOpportunity({ program, function: functionId }) {
			return hasRepeatedPureExpressionAcrossBlocks(program.function(functionId));
		},
	},
	requiredAnalyses: [
		CORE_CONTROL_FLOW_BUNDLE_ANALYSIS,
		CORE_CANONICAL_VALUE_ROOTS_ANALYSIS,
	],
	wakesOn: ["body", "cfg", "exceptionFlow", "memoryEffects"],
	changes: { ...CONTROL_FLOW_CHANGES, cfg: false, facts: true },
	budget: CONTROL_FLOW_BUDGET,
	run(context) {
		const { program, item } = context;
		const fn = program.function(item.function);
		const cfg = context.analysis(CORE_CONTROL_FLOW_BUNDLE_ANALYSIS).exceptional();
		const roots = context.analysis(CORE_CANONICAL_VALUE_ROOTS_ANALYSIS);
		type AvailableExpression = {
			readonly instruction: CoreInstructionId;
			readonly inputs: ReadonlyArray<CoreValueId>;
			readonly value: CoreValueId;
			readonly previous: AvailableExpression | undefined;
		};
		const available = new Map<number, AvailableExpression>();
		const children = new Array<Array<CoreBlockId> | undefined>(fn.blockCapacity);
		const dominatorRoots: Array<CoreBlockId> = [];
		for (const block of cfg.reversePostorder) {
			const parent = cfg.immediateDominators[block];
			if (parent === null || parent === undefined) dominatorRoots.push(block);
			else (children[parent] ??= []).push(block);
		}
		const replacements = new Array<
			| Array<{
					readonly instruction: CoreInstructionId;
					readonly value: CoreValueId;
			  }>
			| undefined
		>(fn.blockCapacity);
		let replacementCount = 0;
		const work: Array<{
			readonly block: CoreBlockId;
			readonly introduced?: ReadonlyArray<number>;
		}> = dominatorRoots.map((block) => ({ block })).reverse();
		while (work.length > 0) {
			const visit = work.pop()!;
			if (visit.introduced !== undefined) {
				// Sibling dominator subtrees must not observe each other's available expressions.
				for (let index = visit.introduced.length - 1; index >= 0; index--) {
					const hash = visit.introduced[index]!;
					const previous = available.get(hash)!.previous;
					if (previous === undefined) available.delete(hash);
					else available.set(hash, previous);
				}
				continue;
			}
			const block = visit.block;
			const introduced: Array<number> = [];
			const terminator = fn.blockTerminator(block);
			for (
				let cursor = fn.kernel.blockFirstInstruction(block);
				cursor >= 0 && cursor !== terminator;
				cursor = fn.kernel.instructionNext(coreInstructionId(cursor))
			) {
				const instruction = coreInstructionId(cursor);
				if (pureExpressionOpcode(fn, instruction) === undefined) continue;
				const inputStart = fn.kernel.instructionOperandStart(instruction);
				const inputCount = fn.kernel.instructionOperandCount(instruction);
				const rooted = new Array<CoreValueId>(inputCount);
				for (let index = 0; index < inputCount; index++) {
					const value = fn.kernel.operandAt(inputStart + index);
					rooted[index] = roots.get(value) ?? value;
				}
				const hash = coreInstructionInputsHash(fn, instruction, rooted);
				const head = available.get(hash);
				let existing = head;
				while (
					existing !== undefined &&
					!expressionsEqual(
						fn,
						instruction,
						existing.instruction,
						rooted,
						existing.inputs,
					)
				)
					existing = existing.previous;
				const existingBlock =
					existing === undefined ? undefined : definitionBlock(fn, existing.value);
				if (
					existing === undefined ||
					existingBlock === undefined ||
					(existingBlock !== block &&
						!cfg.instructionDominatesBlock(existingBlock, block))
				) {
					available.set(hash, {
						instruction,
						inputs: rooted,
						value: instructionResult(fn, instruction, 0)!,
						previous: head,
					});
					introduced.push(hash);
				} else {
					(replacements[block] ??= []).push({ instruction, value: existing.value });
					replacementCount++;
				}
			}
			work.push({ block, introduced });
			const descendants = children[block] ?? [];
			for (let index = descendants.length - 1; index >= 0; index--)
				work.push({ block: descendants[index]! });
		}
		if (replacementCount === 0) return undefined;
		const editor = CoreEditor.open(program, item.function);
		// Keep use-list updates in RPO; their order can affect later candidate selection.
		for (const block of cfg.reversePostorder) {
			for (const { instruction, value } of replacements[block] ?? []) {
				if (!fn.isInstructionLive(instruction)) continue;
				const result = instructionResult(fn, instruction, 0);
				if (result === undefined) continue;
				editor.replaceValueUses(result, value);
				editor.removeInstruction(instruction);
			}
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

const eliminatePartialRedundancy: CoreFunctionPass = {
	name: "partial-redundancy-elimination",
	stage: "control-flow",
	admission: {
		predicate: "join expression with the same pure opcode in an incoming block",
		hasOpportunity({ program, function: functionId }) {
			return hasPartialRedundancyConsumer(program.function(functionId));
		},
	},
	requiredAnalyses: [CORE_CONTROL_FLOW_BUNDLE_ANALYSIS],
	wakesOn: ["body", "cfg", "exceptionFlow", "memoryEffects"],
	changes: { ...CONTROL_FLOW_CHANGES, facts: true },
	budget: CONTROL_FLOW_BUDGET,
	run(context) {
		const { program, item } = context;
		const fn = program.function(item.function);
		const cfg = context.analysis(CORE_CONTROL_FLOW_BUNDLE_ANALYSIS).exceptional();
		const loopHeaders = new Set(cfg.loops.map((loop) => loop.header));
		const expressionsByBlock = new Map<
			CoreBlockId,
			Map<number, Array<CoreInstructionId>>
		>();
		const predecessorExpressions = (block: CoreBlockId) => {
			let expressions = expressionsByBlock.get(block);
			if (expressions !== undefined) return expressions;
			expressions = new Map();
			for (const instruction of fn.bodyInstructionIds(block)) {
				if (pureExpressionOpcode(fn, instruction) === undefined) continue;
				const hash = coreInstructionInputsHash(fn, instruction);
				const bucket = expressions.get(hash) ?? [];
				bucket.push(instruction);
				expressions.set(hash, bucket);
			}
			expressionsByBlock.set(block, expressions);
			return expressions;
		};
		for (const block of cfg.reversePostorder) {
			if (fn.kernel.blockHandlerBlock(block) !== undefined || loopHeaders.has(block))
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
					const hash = coreInstructionInputsHash(fn, instruction, translated[index]);
					const candidate = predecessorExpressions(edge.from)
						.get(hash)
						?.find((candidate) =>
							expressionsEqual(fn, instruction, candidate, translated[index]),
						);
					return candidate === undefined
						? undefined
						: instructionResult(fn, candidate, 0);
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
	range: CompilerIntegerRange,
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

const foldPathComparisons: CoreFunctionPass = {
	name: "path-range-control-folding",
	stage: "control-flow",
	requiredFunctionOpcodesAny: ["binary"],
	admission: {
		predicate: "relational comparison against a numeric constant",
		hasOpportunity({ program, function: functionId }) {
			return hasRelationalConstantComparison(program.function(functionId));
		},
	},
	requiredAnalyses: [CORE_LOOP_INDUCTION_ANALYSIS],
	wakesOn: ["body", "cfg", "normalResults", "representations"],
	changes: { ...CONTROL_FLOW_CHANGES, facts: true },
	budget: CONTROL_FLOW_BUDGET,
	run(context) {
		const { program, item } = context;
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
	"createObjectShaped",
	"defineProperty",
	"loadProperty",
	"storeProperty",
	"storePropertyStatic",
	"storeCaptured",
	"throwIfTdz",
	"yield",
	"terminalYield",
	"await",
]);

const LOOP_SCALAR_PRODUCERS: ReadonlySet<string> = new Set([
	"createNumber",
	"createF64",
	"move",
	"unary",
	"binary",
	"typeofCompare",
]);

function valueWebs(capacity: number) {
	const parents = new Uint32Array(capacity);
	for (let index = 0; index < capacity; index++) parents[index] = index;
	const ranks = new Uint8Array(capacity);
	const root = (value: number): number => {
		let current = value;
		while (parents[current] !== current) current = parents[current]!;
		while (parents[value] !== current) {
			const next = parents[value]!;
			parents[value] = current;
			value = next;
		}
		return current;
	};
	return {
		root,
		connect(left: CoreValueId, right: CoreValueId) {
			let a = root(left);
			let b = root(right);
			if (a === b) return;
			if (ranks[a]! < ranks[b]!) [a, b] = [b, a];
			parents[b] = a;
			if (ranks[a] === ranks[b]) ranks[a] = ranks[a]! + 1;
		},
	};
}

const selectLoopScalarRepresentations: CoreFunctionPass = {
	name: "loop-scalar-representation-selection",
	stage: "control-flow",
	requiredFunctionFeatures: CORE_FUNCTION_HAS_BACKEDGES,
	requiredFunctionOpcodesAny: ["binary", "unary"],
	admission: {
		predicate: "boxed or floating loop parameter with an induction update operation",
		hasOpportunity({ program, function: functionId }) {
			return hasLoopScalarRepresentationConsumer(program.function(functionId));
		},
	},
	requiredAnalyses: [CORE_LOOP_INDUCTION_ANALYSIS, CORE_LOCAL_VALUE_KIND_ANALYSIS],
	wakesOn: ["body", "cfg", "normalResults", "representations"],
	changes: { ...CONTROL_FLOW_CHANGES, representations: true },
	budget: CONTROL_FLOW_BUDGET,
	run(context) {
		const { program, item } = context;
		const fn = program.function(item.function);
		const ranges = context.analysis(CORE_LOOP_INDUCTION_ANALYSIS);
		const { inductions } = ranges;
		if (inductions.length === 0) return undefined;
		const kinds = context.analysis(CORE_LOCAL_VALUE_KIND_ANALYSIS);
		const inductionValues = new Set(
			inductions.flatMap(({ value, initial, update }) => [value, initial, update]),
		);
		const numericCache = new Uint8Array(fn.valueCapacity);
		const numeric = (value: CoreValueId): boolean => {
			if (numericCache[value] === 0)
				numericCache[value] =
					inductionValues.has(value) || kinds.scalarKind(value) === "number" ? 2 : 1;
			return numericCache[value] === 2;
		};
		const discovery = valueWebs(fn.valueCapacity);
		const storage = valueWebs(fn.valueCapacity);
		const connect = (left: CoreValueId, right: CoreValueId, identity: boolean): void => {
			if (!numeric(left) || !numeric(right)) return;
			discovery.connect(left, right);
			// A shared literal is rematerializable; it must not tie unrelated storage widths.
			if (
				identity &&
				numberConstant(fn, left) === undefined &&
				numberConstant(fn, right) === undefined
			)
				storage.connect(left, right);
		};
		const edges = (
			visit: (argument: CoreValueId, target: CoreValueId, handler: boolean) => void,
		) => {
			for (const block of fn.blockIds()) {
				const terminator = fn.blockTerminator(block);
				const start = fn.kernel.terminatorEdgeStart(terminator);
				const count = fn.kernel.terminatorEdgeCount(terminator);
				for (let offset = 0; offset < count; offset++) {
					const row = start + offset;
					const target = fn.kernel.terminatorEdgeBlock(row);
					const parameters = fn.kernel.blockParameterStart(target);
					const arguments_ = fn.kernel.terminatorEdgeArgumentStart(row);
					for (let index = 0; index < fn.kernel.terminatorEdgeArgumentCount(row); index++)
						visit(
							fn.kernel.operandAt(arguments_ + index),
							fn.kernel.blockParameterValue(parameters + index),
							false,
						);
				}
				const handler = fn.kernel.blockHandlerBlock(block);
				if (handler === undefined) continue;
				const parameters = fn.kernel.blockParameterStart(handler);
				const arguments_ = fn.kernel.blockHandlerArgumentStart(block);
				for (let index = 0; index < fn.kernel.blockHandlerArgumentCount(block); index++)
					visit(
						fn.kernel.handlerArgumentAt(arguments_ + index),
						fn.kernel.blockParameterValue(parameters + index + 1),
						true,
					);
			}
		};
		edges((argument, target) => connect(argument, target, true));
		for (const instruction of fn.instructionIds()) {
			const header = fn.instructionHeader(instruction);
			if (typeof header === "string") continue;
			const opcode = header.opcode;
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
			let first: CoreValueId | undefined;
			for (let index = 0; index < operandCount + resultCount; index++) {
				const value =
					index < operandCount
						? fn.kernel.operandAt(operandStart + index)
						: fn.kernel.resultAt(resultStart + index - operandCount);
				if (!numeric(value)) continue;
				if (first === undefined) first = value;
				else connect(first, value, opcode === "move");
			}
		}
		const inductionRoots = new Set([...inductionValues].map(discovery.root));
		const selected = [...fn.valueIds()].filter(
			(value) => inductionRoots.has(discovery.root(value)) && numeric(value),
		);
		const blocked = new Set<number>();
		const representations = new Map<number, CoreRepresentation>();
		for (const value of selected) {
			const root = storage.root(value);
			if (numberConstant(fn, value) !== undefined) continue;
			// Storage is shared across all observations, including the loop's final update.
			const integer =
				kinds.exactScalar(value) === "int32" ||
				compilerIntegerRangeIsInt32(ranges.range(value));
			if (!representations.has(root) || !integer)
				representations.set(root, integer ? "i32" : "f64");
			const definition = definitionInstruction(fn, value);
			if (
				definition !== undefined &&
				!LOOP_SCALAR_PRODUCERS.has(fn.instructionOpcodeName(definition))
			)
				blocked.add(root);
			for (
				let use = fn.kernel.valueFirstUse(value);
				use >= 0;
				use = fn.kernel.useNext(use)
			) {
				const instruction = fn.kernel.useInstruction(use);
				const header = fn.instructionHeader(instruction);
				if (typeof header === "string") continue;
				const opcode = header.opcode;
				const operand = fn.kernel.useOperand(use);
				const callArgument =
					(opcode === "call" && operand >= 2) || (opcode === "callKnown" && operand >= 1);
				if (
					!LOOP_SCALAR_OPERATIONS.has(opcode) &&
					!LOOP_SCALAR_CONSUMERS.has(opcode) &&
					!callArgument
				)
					blocked.add(root);
			}
		}
		const planned = (value: CoreValueId): CoreRepresentation => {
			const root = storage.root(value);
			return (
				(!blocked.has(root) && representations.get(root)) || fn.valueRepresentation(value)
			);
		};
		const literalFits = (
			value: CoreValueId,
			representation: CoreRepresentation,
		): boolean => {
			const literal = numberConstant(fn, value);
			return (
				literal !== undefined &&
				(representation === "f64" ||
					(representation === "i32" &&
						Number.isInteger(literal) &&
						!Object.is(literal, -0) &&
						literal >= -0x8000_0000 &&
						literal <= 0x7fff_ffff))
			);
		};
		let changed: boolean;
		do {
			changed = false;
			const reconcile = (
				source: CoreValueId,
				target: CoreValueId,
				handler: boolean,
				move = false,
			): void => {
				const from = planned(source);
				const to = planned(target);
				if (
					from === to ||
					literalFits(source, to) ||
					(!handler && (to === "boxed" || (from === "i32" && to === "f64"))) ||
					(move &&
						from === fn.valueRepresentation(source) &&
						to === fn.valueRepresentation(target))
				)
					return;
				for (const value of [target, source]) {
					if (planned(value) === fn.valueRepresentation(value)) continue;
					blocked.add(storage.root(value));
					changed = true;
					break;
				}
			};
			edges(reconcile);
			for (const value of selected) {
				const definition = definitionInstruction(fn, value);
				if (definition !== undefined && fn.instructionOpcodeName(definition) === "move")
					reconcile(instructionOperand(fn, definition, 0)!, value, false, true);
			}
		} while (changed);
		const candidates = selected.filter(
			(value) => fn.valueRepresentation(value) !== planned(value),
		);
		if (candidates.length === 0) return undefined;
		const editor = CoreEditor.open(program, item.function);
		for (const value of candidates) editor.setValueRepresentation(value, planned(value));
		const materialize = (
			block: CoreBlockId,
			before: CoreInstructionId,
			source: CoreValueId,
			representation: CoreRepresentation,
		): CoreValueId => {
			const literal = numberConstant(fn, source);
			return editor.insertInstruction(
				block,
				before,
				literal === undefined
					? "move"
					: representation === "i32"
						? "createNumber"
						: "createF64",
				literal === undefined ? [source] : [],
				{
					outputRepresentations: [representation],
					...(literal === undefined ? {} : { attributes: { value: literal } }),
				},
			).outputs[0]!;
		};
		for (const value of selected) {
			const definition = definitionInstruction(fn, value);
			if (definition === undefined || fn.instructionOpcodeName(definition) !== "move")
				continue;
			const source = instructionOperand(fn, definition, 0)!;
			if (planned(source) === planned(value) || !literalFits(source, planned(value)))
				continue;
			editor.replaceInstruction(
				definition,
				planned(value) === "f64" ? "createF64" : "createNumber",
				[],
				{
					attributes: { value: numberConstant(fn, source)! },
					sourcePosition: fn.instructionSourcePosition(definition),
				},
			);
		}
		for (const block of fn.blockIds()) {
			let bridged = false;
			const terminator = fn.blockTerminator(block);
			const replacement = mapTerminatorEdges(fn, terminator, (edge) => {
				const parameterStart = fn.kernel.blockParameterStart(edge.block);
				return {
					block: edge.block,
					arguments: edge.arguments.map((argument, index) => {
						const target = fn.kernel.blockParameterValue(parameterStart + index);
						if (planned(argument) === planned(target)) return argument;
						bridged = true;
						return materialize(block, terminator, argument, planned(target));
					}),
				};
			});
			if (bridged) editor.replaceTerminator(block, replacement);
			const handler = fn.kernel.blockHandlerBlock(block);
			if (handler === undefined) continue;
			const parameters = fn.kernel.blockParameterStart(handler);
			const start = fn.kernel.blockHandlerArgumentStart(block);
			const arguments_ = Array.from(
				{ length: fn.kernel.blockHandlerArgumentCount(block) },
				(_, index) => fn.kernel.handlerArgumentAt(start + index),
			);
			let handlerBridged = false;
			for (let index = 0; index < arguments_.length; index++) {
				const argument = arguments_[index]!;
				const representation = planned(
					fn.kernel.blockParameterValue(parameters + index + 1),
				);
				if (planned(argument) === representation) continue;
				handlerBridged = true;
				// Exception arguments must be available before the protected block starts.
				const definition = definitionInstruction(fn, argument)!;
				arguments_[index] = materialize(
					fn.instructionBlock(definition),
					definition,
					argument,
					representation,
				);
			}
			if (handlerBridged) editor.setHandler(block, handler, arguments_);
		}
		return editor.commit();
	},
};

const reduceBoundedRemainders: CoreFunctionPass = {
	name: "path-range-strength-reduction",
	stage: "control-flow",
	requiredFunctionOpcodesAny: ["binary"],
	admission: {
		predicate: "remainder operation with a potential bounded numeric dividend",
		hasOpportunity({ program, function: functionId }) {
			return hasRemainderStrengthReductionConsumer(program.function(functionId));
		},
	},
	requiredAnalyses: [CORE_LOOP_INDUCTION_ANALYSIS, CORE_LOCAL_VALUE_KIND_ANALYSIS],
	wakesOn: ["body", "cfg", "normalResults", "representations"],
	changes: { ...CONTROL_FLOW_CHANGES, cfg: false, facts: true },
	budget: CONTROL_FLOW_BUDGET,
	run(context) {
		const { program, item } = context;
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
					numericRepresentation(divisorValue) === undefined
				)
					continue;
				const dividend = ranges.range(dividendValue, block);
				if (dividend === undefined) continue;
				let fixedDivisor = numberConstant(fn, divisorValue);
				if (fixedDivisor === undefined) {
					const divisor = ranges.range(divisorValue, block);
					if (divisor === undefined || divisor.minimum !== divisor.maximum) continue;
					fixedDivisor = divisor.minimum;
				}
				const magnitude = Math.abs(fixedDivisor);
				if (
					!(magnitude > 0) ||
					dividend.minimum <= -magnitude ||
					dividend.maximum >= magnitude
				)
					continue;
				const from = fn.valueRepresentation(dividendValue);
				const to = fn.valueRepresentation(output);
				let conversion: "+" | "toint32" | undefined;
				if (!coreRepresentationCanWiden(from, to)) {
					if (to === "f64" && from === "boxed") conversion = "+";
					else if (
						to === "i32" &&
						(from === "boxed" || from === "f64") &&
						compilerIntegerRangeIsInt32(dividend)
					)
						conversion = "toint32";
					else continue;
				}
				editor ??= CoreEditor.open(program, item.function);
				editor.replaceInstruction(
					instruction,
					conversion === undefined ? "move" : "unary",
					[dividendValue],
					conversion === undefined ? {} : { attributes: { operator: conversion } },
				);
			}
		}
		return editor?.commit();
	},
};

export const CORE_CONTROL_FLOW_PASSES: ReadonlyArray<CoreFunctionPass> = [
	canonicalizeNaturalLoops,
	hoistLoopInvariants,
	cacheStablePrivateReads,
	eliminateDominatedRedundancy,
	eliminatePartialRedundancy,
	selectLoopScalarRepresentations,
	foldPathComparisons,
	reduceBoundedRemainders,
];

export const CORE_LATE_REPRESENTATION_PASSES: ReadonlyArray<CoreFunctionPass> = [
	selectLoopScalarRepresentations,
];
