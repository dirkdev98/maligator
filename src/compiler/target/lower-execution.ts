import { coreCompilerSiteId } from "../core/compiler-site-facts.ts";
import type { CoreCompilation } from "../core/core-compilation.ts";
import {
	CORE_CALLEE_TARGETS_ATTRIBUTE,
	CORE_CALL_PARAMETER_CONTAINMENT_ATTRIBUTE,
	CORE_CALL_PARAMETER_ESCAPE_ATTRIBUTE,
	CORE_CALL_RETURN_PROVENANCE_ATTRIBUTE,
	CORE_CALL_RETURN_REPRESENTATION_ATTRIBUTE,
	CORE_CALL_SUMMARY_VERSION_ATTRIBUTE,
	CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE,
} from "../core/core-cross-call-transforms.ts";
import { coreTerminatorEdges } from "../core/core-ir-control-flow.ts";
import {
	CORE_CONTAINED_DENSE_ARRAY_ELEMENT_ATTRIBUTE,
	CORE_FRESH_ARRAY_LENGTH_ATTRIBUTE,
} from "../core/core-ir-provenance.ts";
import type {
	CoreAllocatedRegion,
	CoreDirectEntryPlan,
	CorePlanRepresentation,
	CorePlanSpecialization,
} from "../core/core-ir-regions.ts";
import { CORE_EXACT_SHAPE_OWN_SLOT_ATTRIBUTE } from "../core/core-ir-shape-provenance.ts";
import { CORE_CALL_SUMMARY_ATTRIBUTE } from "../core/core-ir-summaries.ts";
import {
	CORE_EXACT_COLLECTION_RECEIVER_ATTRIBUTE,
	CORE_EXACT_TYPED_ARRAY_KIND_ATTRIBUTE,
} from "../core/core-ir-value-classes.ts";
import {
	CORE_EXACT_BINARY_INPUT_KIND_MASKS_ATTRIBUTE,
	CORE_EXACT_CALL_ARGUMENT_REPRESENTATIONS_ATTRIBUTE,
	CORE_EXACT_SCALAR_AFTER_TDZ_ATTRIBUTE,
} from "../core/core-ir-value-kinds.ts";
import type {
	CoreBlockId,
	CoreEdge,
	CoreAttributeValue,
	CoreFunctionId,
	CoreImmediate,
	CoreInstructionAttributes,
	CoreInstructionId,
	CoreRepresentation,
	CoreValueId,
} from "../core/core-ir.ts";
import { assertCoreOptimizationPlanCertificate } from "../core/core-optimization-plan-certificate.ts";
import type { CoreFunctionStore } from "../core/core-store.ts";
import type { CompilerSiteFacts } from "../shared/compiler-facts.ts";
import { COMPILER_TWO_ADDRESS_OPERANDS } from "../shared/compiler-instruction.ts";
import type {
	CompilerImmediateValue,
	CompilerInstruction,
} from "../shared/compiler-instruction.ts";
import {
	coreInstructionNeedsOperationSafepoint,
	requireCoreTargetOperationContract,
} from "./core-operation-contract.ts";
import type {
	ExecutionFunction,
	ExecutionFunctionMap,
	ExecutionMove,
	ExecutionParallelCopy,
	ExecutionProgram,
	ExecutionRegisterRepresentation,
	ExecutionSafepoint,
} from "./execution-ir.ts";
import { executionFunctionIndex } from "./execution-ir.ts";
import {
	executionLoopBackedgeInstructions,
	executionSafepointRootRegisters,
} from "./execution-liveness.ts";
import { verifyExecutionProgram } from "./verify-execution.ts";

export type {
	ExecutionFunction,
	ExecutionMove,
	ExecutionParallelCopy,
	ExecutionProgram,
	ExecutionSafepoint,
} from "./execution-ir.ts";

export interface LowerCoreToExecutionOptions {
	readonly reuseRegisters?: boolean;
}

interface LoweredParallelCopy {
	readonly moves: Array<ExecutionMove>;
	readonly temporaries: Array<number>;
}

const REGISTERLESS_CORE_OPERATIONS: ReadonlySet<string> = new Set([
	"asyncStart",
	"createPrivateNames",
	"envCopy",
	"envPop",
	"envPush",
	"generatorStart",
	"initGlobalVars",
]);

const RAW_ARGUMENT_OPCODES: ReadonlySet<string> = new Set([
	"loadArgumentCount",
	"loadArgument",
	"loadStaticArgument",
	"createArgumentsObject",
	"createRestArguments",
]);

export function coreSupportsDirectEntries(fn: CoreFunctionStore): boolean {
	return (
		!fn.isGenerator &&
		!fn.isAsync &&
		!fn.metadata.isClassConstructor &&
		!fn.metadata.isDerivedConstructor &&
		!fn.metadata.mappedArguments &&
		![...fn.instructionIds()].some(
			(instruction) =>
				fn.instructionKind(instruction) === "operation" &&
				RAW_ARGUMENT_OPCODES.has(fn.instructionOpcodeName(instruction)),
		)
	);
}

const FUNCTION_INDEX_ATTRIBUTES: ReadonlySet<string> = new Set([
	"functionIndex",
	"directFunctionIndex",
	"directCallTargetFunctionIndex",
	"directCallbackFunctionIndex",
]);

const CORE_INTERNAL_ATTRIBUTES: ReadonlySet<string> = new Set([
	CORE_CALLEE_TARGETS_ATTRIBUTE,
	CORE_CALL_SUMMARY_ATTRIBUTE,
	CORE_CALL_SUMMARY_VERSION_ATTRIBUTE,
	CORE_CALL_PARAMETER_ESCAPE_ATTRIBUTE,
	CORE_CALL_PARAMETER_CONTAINMENT_ATTRIBUTE,
	CORE_CALL_RETURN_PROVENANCE_ATTRIBUTE,
	CORE_CALL_RETURN_REPRESENTATION_ATTRIBUTE,
	CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE,
	CORE_CONTAINED_DENSE_ARRAY_ELEMENT_ATTRIBUTE,
	CORE_FRESH_ARRAY_LENGTH_ATTRIBUTE,
	CORE_EXACT_COLLECTION_RECEIVER_ATTRIBUTE,
	CORE_EXACT_TYPED_ARRAY_KIND_ATTRIBUTE,
	CORE_EXACT_BINARY_INPUT_KIND_MASKS_ATTRIBUTE,
	CORE_EXACT_CALL_ARGUMENT_REPRESENTATIONS_ATTRIBUTE,
	CORE_EXACT_SCALAR_AFTER_TDZ_ATTRIBUTE,
	CORE_EXACT_SHAPE_OWN_SLOT_ATTRIBUTE,
	"directStringCharCodeAtPosition",
	"primitiveStringLength",
	"directFunctionCall",
	"directCallTargetFunctionIndex",
]);

function isCoreAttributeArray(
	value: CoreAttributeValue,
): value is ReadonlyArray<CoreAttributeValue> {
	return Array.isArray(value);
}

function parallelMoves(
	assignments: ReadonlyArray<{
		readonly destination: number;
		readonly source: number;
	}>,
	nextRegister: { value: number },
	registerRepresentations: Map<number, CoreRepresentation>,
): LoweredParallelCopy {
	const pending = assignments
		.filter(({ destination, source }) => destination !== source)
		.map((assignment) => ({ ...assignment }));
	const moves: Array<ExecutionMove> = [];
	const temporaries: Array<number> = [];
	while (pending.length > 0) {
		const ready = pending.findIndex(
			({ destination }) => !pending.some(({ source }) => source === destination),
		);
		if (ready >= 0) {
			const [assignment] = pending.splice(ready, 1);
			moves.push({
				type: "move",
				registers: [assignment!.destination, assignment!.source],
			});
			continue;
		}
		const saved = pending[0]!.destination;
		const temporary = nextRegister.value++;
		const representation = registerRepresentations.get(saved);
		if (representation === undefined) {
			throw new Error(`Parallel move has no Core representation for r${saved}`);
		}
		registerRepresentations.set(temporary, representation);
		temporaries.push(temporary);
		moves.push({ type: "move", registers: [temporary, saved] });
		for (const assignment of pending) {
			if (assignment.source === saved) assignment.source = temporary;
		}
	}
	return { moves, temporaries };
}

export function physicalRegisterClass(
	representation: CoreRepresentation,
): ExecutionRegisterRepresentation {
	if (representation === "i32") return "int32";
	if (representation === "f64") return "number";
	if (representation === "boolean") return "boolean";
	return representation === "string" ? "string" : "boxed";
}

function createExecutionFunctionMap(compilation: CoreCompilation): ExecutionFunctionMap {
	const executionToCore = [...compilation.plan.liveFunctions];
	const coreToExecution = Array<number>(compilation.program.functionCapacity).fill(-1);
	for (const [execution, core] of executionToCore.entries()) {
		coreToExecution[core] = execution;
	}
	return Object.freeze({
		coreToExecution: Object.freeze(coreToExecution),
		executionToCore: Object.freeze(executionToCore),
	});
}

function relocateFunctionReferences(
	attributes: CoreInstructionAttributes,
	map: ExecutionFunctionMap,
): CoreInstructionAttributes {
	let changed = false;
	const relocated: Record<string, CoreAttributeValue> = { ...attributes };
	for (const key of FUNCTION_INDEX_ATTRIBUTES) {
		const value = attributes[key];
		if (typeof value !== "number" || value < 0) continue;
		relocated[key] = executionFunctionIndex(map, value);
		changed = true;
	}
	const guarded = attributes.guardedFunctionIndices;
	if (isCoreAttributeArray(guarded)) {
		relocated.guardedFunctionIndices = guarded.map((value) =>
			typeof value === "number" ? executionFunctionIndex(map, value) : value,
		);
		changed = true;
	}
	return changed ? relocated : attributes;
}

function sourcePositionMarker(position: number | undefined): Array<CompilerInstruction> {
	return position === undefined ? [] : [{ type: "sourcePos", pos: position }];
}

function lowerCoreImmediate(
	value: CoreImmediate,
	destination: number,
): CompilerInstruction {
	switch (value.kind) {
		case "undefined":
			return { type: "createUndefined", registers: [destination] };
		case "null":
			return { type: "createNull", registers: [destination] };
		case "boolean":
			return { type: "createBoolean", registers: [destination], value: value.value };
		case "number":
			return { type: "createNumber", registers: [destination], value: value.value };
		case "string":
			return { type: "createString", registers: [destination], stringIndex: value.index };
	}
}

function coreImmediateValue(
	fn: CoreFunctionStore,
	value: CoreValueId,
): CompilerImmediateValue | undefined {
	const definition = fn.valueDefinition(value);
	if (definition.kind !== "instruction" || definition.index !== 0) return undefined;
	const instruction = definition.instruction;
	if (fn.instructionKind(instruction) !== "operation") return undefined;
	const attributes = fn.instructionAttributes(instruction);
	switch (fn.instructionOpcodeName(instruction)) {
		case "createUndefined":
			return { kind: "undefined" };
		case "createNull":
			return { kind: "null" };
		case "createBoolean":
			return typeof attributes.value === "boolean"
				? { kind: "boolean", value: attributes.value }
				: undefined;
		case "createNumber":
		case "createF64": {
			const number = attributes.value;
			return typeof number === "number" &&
				Number.isInteger(number) &&
				!Object.is(number, -0) &&
				number >= -0x0800_0000 &&
				number <= 0x07ff_ffff
				? { kind: "number", value: number }
				: undefined;
		}
		case "createString": {
			const index = attributes.stringIndex;
			return typeof index === "number" && index <= 0x0fff_ffff
				? { kind: "string", index }
				: undefined;
		}
		default:
			return undefined;
	}
}

function immediateOnlyInstructions(
	fn: CoreFunctionStore,
	protectedInstructions: ReadonlySet<CoreInstructionId>,
): ReadonlySet<CoreInstructionId> {
	const embedded = new Set<CoreValueId>();
	const ordinary = new Set<CoreValueId>();
	for (const block of fn.blockIds()) {
		for (const instruction of fn.bodyInstructionIds(block)) {
			const embeddable =
				!protectedInstructions.has(instruction) &&
				["call", "callBuiltin", "construct"].includes(
					fn.instructionOpcodeName(instruction),
				);
			for (const input of fn.instructionOperands(instruction)) {
				if (embeddable && coreImmediateValue(fn, input) !== undefined) {
					embedded.add(input);
				} else {
					ordinary.add(input);
				}
			}
		}
		const terminator = fn.terminatorPayload(fn.blockTerminator(block));
		switch (terminator.kind) {
			case "branch":
			case "guard":
				ordinary.add(terminator.condition);
				break;
			case "switch":
				ordinary.add(terminator.discriminant);
				break;
			case "return":
			case "throw":
				ordinary.add(terminator.value);
				break;
			case "jump":
			case "unreachable":
				break;
		}
		for (const edge of coreTerminatorEdges(terminator)) {
			for (const argument of edge.arguments) ordinary.add(argument);
		}
		for (const argument of fn.blockHandler(block)?.arguments ?? [])
			ordinary.add(argument);
	}
	const omitted = new Set<CoreInstructionId>();
	for (const block of fn.blockIds()) {
		for (const instruction of fn.bodyInstructionIds(block)) {
			if (protectedInstructions.has(instruction)) continue;
			const results = fn.instructionResults(instruction);
			if (
				results.length > 0 &&
				results.every((result) => embedded.has(result) && !ordinary.has(result))
			) {
				omitted.add(instruction);
			}
		}
	}
	return omitted;
}

function rebuildOperation(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	registerForValue: (value: CoreValueId) => number,
	functionMap: ExecutionFunctionMap,
	directEntryId: number | undefined,
	guardedTargets: ReadonlyArray<CoreFunctionId> | undefined,
	knownBuiltinCall: CoreAttributeValue | undefined,
	exactCollectionReceiver: CoreAttributeValue | undefined,
	exactArrayLength: CoreAttributeValue | undefined,
	directStringCharCodeAtPosition: CoreAttributeValue | undefined,
	primitiveStringLength: CoreAttributeValue | undefined,
	directFunctionCall: CoreAttributeValue | undefined,
	directCallTargetFunctionIndex: CoreAttributeValue | undefined,
	allowImmediateOperands: boolean,
): CompilerInstruction {
	const opcode = fn.instructionOpcodeName(instruction);
	const contract = requireCoreTargetOperationContract(opcode);
	const selectedAttributes: Record<string, CoreAttributeValue> = Object.fromEntries(
		Object.entries(fn.instructionAttributes(instruction)).filter(
			([key]) => !CORE_INTERNAL_ATTRIBUTES.has(key),
		),
	);
	if (directEntryId !== undefined) selectedAttributes.directEntryId = directEntryId;
	if (knownBuiltinCall !== undefined)
		selectedAttributes.knownBuiltinCall = knownBuiltinCall;
	if (exactCollectionReceiver !== undefined) {
		selectedAttributes.exactCollectionReceiver = exactCollectionReceiver;
	}
	if (exactArrayLength !== undefined) {
		selectedAttributes.exactArrayLength = exactArrayLength;
	}
	if (directStringCharCodeAtPosition !== undefined) {
		selectedAttributes.directStringCharCodeAtPosition = directStringCharCodeAtPosition;
	}
	if (primitiveStringLength !== undefined) {
		selectedAttributes.primitiveStringLength = primitiveStringLength;
	}
	if (directFunctionCall !== undefined) {
		selectedAttributes.directFunctionCall = directFunctionCall;
	}
	if (directCallTargetFunctionIndex !== undefined) {
		selectedAttributes.directCallTargetFunctionIndex = directCallTargetFunctionIndex;
	}
	delete selectedAttributes.directFunctionIndex;
	delete selectedAttributes.guardedFunctionIndices;
	if (guardedTargets !== undefined) {
		if (guardedTargets.length === 1) {
			selectedAttributes.directFunctionIndex = guardedTargets[0]!;
		} else {
			selectedAttributes.guardedFunctionIndices = guardedTargets;
		}
	}
	const attributes = relocateFunctionReferences(selectedAttributes, functionMap);
	const outputs = fn.instructionResults(instruction);
	const inputs = fn.instructionOperands(instruction);
	const registers = [...outputs, ...inputs].map(registerForValue);
	const immediateValues: Array<CompilerImmediateValue | undefined> = [];
	if (
		allowImmediateOperands &&
		(opcode === "call" || opcode === "callBuiltin" || opcode === "construct")
	) {
		for (const [index, input] of inputs.entries()) {
			const immediate = coreImmediateValue(fn, input);
			if (immediate === undefined) continue;
			const position = outputs.length + index;
			registers[position] = -1;
			immediateValues[position] = immediate;
		}
	}
	return {
		type: contract.targetType,
		...attributes,
		...(immediateValues.length === 0 ? {} : { immediateValues }),
		...(REGISTERLESS_CORE_OPERATIONS.has(opcode) ? {} : { registers }),
	} as CompilerInstruction;
}

function lowerCoreSpecializations(
	fn: CoreFunctionStore,
	selections: ReadonlyArray<CorePlanSpecialization>,
	instructions: ReadonlyMap<CoreInstructionId, CompilerInstruction>,
	blocks: ReadonlyMap<CoreBlockId, number>,
	registerForValue: (value: CoreValueId) => number,
): ReadonlyArray<CoreAllocatedRegion> {
	const requireInstruction = (instruction: CoreInstructionId): CompilerInstruction => {
		const lowered = instructions.get(instruction);
		if (lowered === undefined) {
			throw new Error(`Core plan lowering lost instruction @${instruction}`);
		}
		return lowered;
	};
	const requireBlock = (block: CoreBlockId): number => {
		const lowered = blocks.get(block);
		if (lowered === undefined) throw new Error(`Core plan lowering lost block b${block}`);
		return lowered;
	};
	const envelope = (selection: CorePlanSpecialization) => ({
		anchors: selection.anchors.map(requireInstruction),
		claimedInstructions: selection.claimedInstructions.map(requireInstruction),
		controlFlow: {
			ordinaryBlocks: selection.ordinaryBlocks.map(requireBlock),
			exceptionalBlocks: selection.exceptionalBlocks.map(requireBlock),
		},
		cost: {
			score: selection.claimedInstructions.length - 1,
			metadataOperations: selection.claimedInstructions.length,
		},
	});
	const admission = (selection: CorePlanSpecialization) => ({
		anchor: requireInstruction(selection.admission.anchor),
		mode: selection.admission.mode,
	});
	const regions: Array<CoreAllocatedRegion> = [];
	for (const selection of selections) {
		if (
			selection.kind === "guarded-direct-call" ||
			selection.kind === "fresh-array-length" ||
			selection.kind === "function-call-chain"
		)
			continue;
		const anchor = selection.anchors[0]!;
		const loweredAnchor = requireInstruction(anchor);
		if (selection.kind === "numeric-fusion") {
			if (loweredAnchor.type !== "binary") {
				throw new Error(`Core numeric plan ${selection.id} does not lower to binary`);
			}
			const result = fn.instructionResults(anchor)[0];
			if (result === undefined) {
				throw new Error(`Core numeric plan ${selection.id} has no result`);
			}
			const pairs = selection.claimedInstructions.slice(1).map((instruction) => {
				const lowered = requireInstruction(instruction);
				const operands = fn.instructionOperands(instruction);
				const input = operands.indexOf(result);
				if (lowered.type !== "binary" || (input !== 0 && input !== 1)) {
					throw new Error(`Core numeric plan ${selection.id} has an invalid finish`);
				}
				return {
					first: loweredAnchor,
					finish: lowered,
					firstUsePosition: (input + 1) as 1 | 2,
				};
			});
			if (pairs.length === 0) {
				throw new Error(`Core numeric plan ${selection.id} has no fused pair`);
			}
			regions.push({
				...envelope(selection),
				anchors: [loweredAnchor, pairs[0]!.finish],
				kind: "numeric-fusion",
				license: {
					guard: "structural",
					genericTwin: "retained",
					materialization: "none",
					admission: admission(selection),
				},
				representation: "binary-pairs-f64",
				composition: "overlay",
				runtimeGuard: "number-operands",
				pairs,
			});
			continue;
		}
		if (selection.kind === "indexed-length-loop") {
			const indexed = selection.indexedLengthLoop;
			const load = requireInstruction(indexed.load);
			const comparison = requireInstruction(indexed.comparison);
			if (load.type !== "loadPropertyStatic" || comparison.type !== "binary") {
				throw new Error(`Core indexed-length plan ${selection.id} lost its anchors`);
			}
			const elements = indexed.elements.map((element) => {
				const instruction = requireInstruction(element.instruction);
				if (
					(element.kind === "load" && instruction.type !== "loadProperty") ||
					(element.kind === "store" && instruction.type !== "storeProperty")
				) {
					throw new Error(`Core indexed-length plan ${selection.id} lost an element`);
				}
				return {
					instruction: instruction as Extract<
						CompilerInstruction,
						{ type: "loadProperty" | "storeProperty" }
					>,
					kind: element.kind,
				};
			});
			regions.push({
				...envelope(selection),
				anchors: [load, comparison],
				kind: "indexed-length-loop",
				license: {
					guard: "structural",
					genericTwin: "retained",
					materialization: "none",
					admission: admission(selection),
				},
				representation: "live-indexed-length-loops",
				cost: {
					score: 4 + elements.length * 3,
					metadataOperations: 2 + elements.length,
				},
				runtimeGuard: "array-or-numeric-typed-array",
				sites: [
					{
						load,
						comparison,
						lengthPosition: indexed.lengthPosition,
						elements,
					},
				],
			});
			continue;
		}
		if (
			selection.kind === "array-values-iterator-cursor" ||
			selection.kind === "string-iterator-cursor" ||
			selection.kind === "typed-array-iterator-cursor" ||
			selection.kind === "map-iterator-cursor" ||
			selection.kind === "set-iterator-cursor"
		) {
			const cursor = selection.iteratorCursor;
			const initialize = requireInstruction(cursor.initialize);
			const steps = cursor.steps.map(requireInstruction);
			if (
				initialize.type !== "getIterator" ||
				steps.length === 0 ||
				steps.some((step) => step.type !== "iteratorStep")
			) {
				throw new Error(`Core iterator plan ${selection.id} lost its protocol steps`);
			}
			const iteratorSteps = steps.filter(
				(step): step is Extract<CompilerInstruction, { type: "iteratorStep" }> =>
					step.type === "iteratorStep",
			);
			const common = {
				...envelope(selection),
				anchors: [initialize, iteratorSteps[0]!] as const,
				license: {
					guard: "structural" as const,
					genericTwin: "retained" as const,
					materialization: "none" as const,
					admission: admission(selection),
				},
				cost: {
					score: iteratorSteps.length * 8,
					metadataOperations: 1 + iteratorSteps.length,
				},
				initialize,
				steps: iteratorSteps,
				runtimeGuard: "exact-iterator-brand-next-target" as const,
				stateSynchronization: "authoritative-language-object" as const,
				suspension: "forbidden" as const,
			};
			switch (selection.kind) {
				case "array-values-iterator-cursor":
					regions.push({
						...common,
						kind: selection.kind,
						representation: "array-values-authoritative-cursor",
						protocol: "array-values",
					});
					break;
				case "string-iterator-cursor":
					regions.push({
						...common,
						kind: selection.kind,
						representation: "string-authoritative-cursor",
						protocol: "string",
					});
					break;
				case "typed-array-iterator-cursor":
					regions.push({
						...common,
						kind: selection.kind,
						representation: "typed-array-authoritative-cursor",
						protocol: "typed-array-values",
					});
					break;
				case "map-iterator-cursor":
					regions.push({
						...common,
						kind: selection.kind,
						representation: "map-authoritative-cursor",
						protocol: "map",
					});
					break;
				case "set-iterator-cursor":
					regions.push({
						...common,
						kind: selection.kind,
						representation: "set-authoritative-cursor",
						protocol: "set",
					});
					break;
			}
			continue;
		}
		if (selection.kind === "iterator-result-virtualization") {
			const virtualization = selection.iteratorResultVirtualization;
			const steps = virtualization.steps.map(requireInstruction);
			if (steps.length === 0 || steps.some((step) => step.type !== "iteratorStep")) {
				throw new Error(`Core iterator-result plan ${selection.id} lost its steps`);
			}
			const iteratorSteps = steps.filter(
				(step): step is Extract<CompilerInstruction, { type: "iteratorStep" }> =>
					step.type === "iteratorStep",
			);
			regions.push({
				...envelope(selection),
				anchors: [iteratorSteps[0]!] as const,
				kind: "iterator-result-virtualization",
				license: {
					guard: virtualization.guard,
					genericTwin: "retained",
					materialization: "on-demand",
					admission: admission(selection),
				},
				representation: "virtual-iterator-result",
				composition: "overlay",
				cost: {
					score: iteratorSteps.length * 6,
					metadataOperations: iteratorSteps.length,
				},
				steps: iteratorSteps,
				runtimeGuard: "exact-builtin-iterator-next",
				correspondence: "done-value-observation",
				fallback: "materialize-result-then-observe",
			});
			continue;
		}
		if (selection.kind === "iterator-entry-pair-virtualization") {
			const entry = selection.iteratorEntryPairVirtualization;
			const cursorInitialize = requireInstruction(entry.cursorInitialize);
			const outerStep = requireInstruction(entry.outerStep);
			const innerInitialize = requireInstruction(entry.innerInitialize);
			const innerSteps = entry.innerSteps.map(requireInstruction);
			const innerCloses = entry.innerCloses.map(requireInstruction);
			if (
				cursorInitialize.type !== "getIterator" ||
				outerStep.type !== "iteratorStep" ||
				innerInitialize.type !== "getIterator" ||
				innerSteps.some((step) => step.type !== "iteratorStep") ||
				innerCloses.some((close) => close.type !== "iteratorClose")
			) {
				throw new Error(`Core iterator-entry plan ${selection.id} lost its protocol`);
			}
			const loweredInnerSteps = innerSteps.filter(
				(step): step is Extract<CompilerInstruction, { type: "iteratorStep" }> =>
					step.type === "iteratorStep",
			);
			const loweredInnerCloses = innerCloses.filter(
				(close): close is Extract<CompilerInstruction, { type: "iteratorClose" }> =>
					close.type === "iteratorClose",
			);
			if (loweredInnerSteps.length !== 2) {
				throw new Error(`Core iterator-entry plan ${selection.id} lost its pair steps`);
			}
			regions.push({
				...envelope(selection),
				anchors: [outerStep, innerInitialize] as const,
				kind: "iterator-entry-pair-virtualization",
				license: {
					guard: entry.guard,
					genericTwin: "retained",
					materialization: "on-demand",
					admission: admission(selection),
				},
				representation: "virtual-iterator-entry-pair",
				composition: "overlay",
				cost: { score: 32, metadataOperations: selection.claimedInstructions.length },
				cursorInitialize,
				outerStep,
				innerInitialize,
				innerSteps: [loweredInnerSteps[0]!, loweredInnerSteps[1]!],
				innerCloses: loweredInnerCloses,
				runtimeGuard: "exact-map-or-set-entry-cursor",
				correspondence: "entry-pair-elements",
				stateSynchronization: "authoritative-language-object",
				fallback: "materialize-entry-pair-then-iterate",
			});
			continue;
		}
		if (selection.kind === "string-split-cursor") {
			const cursor = selection.stringSplitCursor;
			const property =
				cursor.property === undefined ? undefined : requireInstruction(cursor.property);
			const call = requireInstruction(cursor.call);
			const length = requireInstruction(cursor.length);
			const compare = requireInstruction(cursor.compare);
			const branch = requireInstruction(cursor.branch);
			const element = requireInstruction(cursor.element);
			const trimProperty = requireInstruction(cursor.trimProperty);
			const trimCall = requireInstruction(cursor.trimCall);
			const advance =
				cursor.advance === undefined ? undefined : requireInstruction(cursor.advance);
			const increment = requireInstruction(cursor.increment);
			const backedge = requireInstruction(cursor.backedge);
			const primitiveStringLengths =
				cursor.primitiveStringLengths.map(requireInstruction);
			if (
				(property !== undefined && property.type !== "loadPropertyStatic") ||
				(call.type !== "call" && call.type !== "callBuiltin") ||
				length.type !== "loadPropertyStatic" ||
				compare.type !== "binary" ||
				branch.type !== "jumpIf" ||
				element.type !== "loadProperty" ||
				trimProperty.type !== "loadPropertyStatic" ||
				trimCall.type !== "call" ||
				(advance !== undefined && advance.type !== "unary") ||
				increment.type !== "unary" ||
				backedge.type !== "jump" ||
				primitiveStringLengths.some(
					(primitiveLength) => primitiveLength.type !== "loadPropertyStatic",
				)
			) {
				throw new Error(`Core String.split cursor ${selection.id} lost its trace`);
			}
			regions.push({
				...envelope(selection),
				anchors: [call, branch, length, backedge],
				kind: "string-split-cursor",
				license: {
					guard: cursor.guard,
					genericTwin: "retained",
					materialization: "on-demand",
					admission: admission(selection),
				},
				representation: "split-cursor-spans",
				...(property === undefined ? {} : { property }),
				propertyPlacement: cursor.propertyPlacement,
				splitIdentity: cursor.splitIdentity,
				trimIdentity: cursor.trimIdentity,
				compare,
				element,
				trimProperty,
				trimCall,
				...(advance?.type === "unary" ? { advance } : {}),
				increment,
				resultRegisters: cursor.resultValues.map(registerForValue),
				primitiveStringLengths: primitiveStringLengths.filter(
					(
						primitiveLength,
					): primitiveLength is Extract<
						CompilerInstruction,
						{ type: "loadPropertyStatic" }
					> => primitiveLength.type === "loadPropertyStatic",
				),
				exitBlock: requireBlock(cursor.exitBlock),
			});
			continue;
		}
		if (selection.kind === "string-split-projection") {
			const split = selection.stringSplitProjection;
			const call = requireInstruction(split.call);
			const property =
				split.property === undefined ? undefined : requireInstruction(split.property);
			const separator = requireInstruction(split.separator);
			if (
				(call.type !== "call" && call.type !== "callBuiltin") ||
				(property !== undefined && property.type !== "loadPropertyStatic") ||
				separator.type !== "createString"
			) {
				throw new Error(`Core String.split plan ${selection.id} lost its producers`);
			}
			const loads = split.loads.map((load) => {
				const instruction = requireInstruction(load.instruction);
				if (load.kind === "length") {
					if (instruction.type !== "loadPropertyStatic") {
						throw new Error(`Core String.split plan ${selection.id} lost a length load`);
					}
					return { instruction, kind: "length" as const };
				}
				const key = requireInstruction(load.key);
				if (instruction.type !== "loadProperty" || key.type !== "createNumber") {
					throw new Error(`Core String.split plan ${selection.id} lost an element load`);
				}
				return {
					instruction,
					kind: "element" as const,
					index: load.index,
					key,
				};
			});
			regions.push({
				...envelope(selection),
				anchors: [call, loads[0]!.instruction],
				kind: "string-split-projection",
				license: {
					guard: split.guard,
					genericTwin: "retained",
					materialization: "whole-region",
					admission: admission(selection),
				},
				representation: "projected-elements",
				...(property === undefined ? {} : { property }),
				propertyPlacement: split.propertyPlacement,
				splitIdentity: split.splitIdentity,
				separator,
				separatorStringIndex: split.separatorStringIndex,
				resultRegisters: split.resultValues.map(registerForValue),
				loads,
			});
			continue;
		}
		if (selection.kind === "regexp-exec-projection") {
			const regexp = selection.regexpExecProjection;
			const call = requireInstruction(regexp.call);
			const property = requireInstruction(regexp.property);
			if (call.type !== "call" || property.type !== "loadPropertyStatic") {
				throw new Error(`Core RegExp.exec plan ${selection.id} lost its call`);
			}
			const nullChecks = regexp.nullChecks.map((check) => {
				const comparison = requireInstruction(check.comparison);
				const nullValue = requireInstruction(check.nullValue);
				if (comparison.type !== "binary" || nullValue.type !== "createNull") {
					throw new Error(`Core RegExp.exec plan ${selection.id} lost a null check`);
				}
				return { comparison, nullValue };
			});
			const lockedLiteral =
				regexp.lockedLiteral === undefined
					? undefined
					: (() => {
							const constructorIntrinsic = requireInstruction(
								regexp.lockedLiteral.constructorIntrinsic,
							);
							const construct = requireInstruction(regexp.lockedLiteral.construct);
							if (
								constructorIntrinsic.type !== "loadIntrinsic" ||
								construct.type !== "construct"
							) {
								throw new Error(`Core RegExp.exec plan ${selection.id} lost its literal`);
							}
							return { constructorIntrinsic, construct };
						})();
			const loads = regexp.loads.map((load) => {
				const instruction = requireInstruction(load.instruction);
				const key = requireInstruction(load.key);
				if (instruction.type !== "loadProperty" || key.type !== "createNumber") {
					throw new Error(`Core RegExp.exec plan ${selection.id} lost a capture`);
				}
				const consumer = load.consumer;
				if (consumer === undefined) {
					return {
						instruction,
						key,
						captureIndex: load.captureIndex,
					};
				}
				if (consumer.kind === "length") {
					const consumerProperty = requireInstruction(consumer.property);
					if (consumerProperty.type !== "loadPropertyStatic") {
						throw new Error(`Core RegExp.exec plan ${selection.id} lost a length`);
					}
					return {
						instruction,
						key,
						captureIndex: load.captureIndex,
						consumer: { kind: "length" as const, property: consumerProperty },
					};
				}
				if (consumer.kind === "number") {
					const intrinsic = requireInstruction(consumer.intrinsic);
					const consumerCall = requireInstruction(consumer.call);
					if (intrinsic.type !== "loadIntrinsic" || consumerCall.type !== "call") {
						throw new Error(`Core RegExp.exec plan ${selection.id} lost Number`);
					}
					return {
						instruction,
						key,
						captureIndex: load.captureIndex,
						consumer: { kind: "number" as const, intrinsic, call: consumerCall },
					};
				}
				if (consumer.kind === "charCodeAtZero") {
					const consumerProperty = requireInstruction(consumer.property);
					const consumerCall = requireInstruction(consumer.call);
					const zero =
						consumer.zero === undefined ? undefined : requireInstruction(consumer.zero);
					if (
						consumerProperty.type !== "loadPropertyStatic" ||
						consumerCall.type !== "call" ||
						(zero !== undefined && zero.type !== "createNumber")
					) {
						throw new Error(`Core RegExp.exec plan ${selection.id} lost charCodeAt`);
					}
					return {
						instruction,
						key,
						captureIndex: load.captureIndex,
						consumer: {
							kind: "charCodeAtZero" as const,
							methodIdentity: consumer.methodIdentity,
							property: consumerProperty,
							call: consumerCall,
							...(zero === undefined ? {} : { zero }),
						},
					};
				}
				const upperProperty = requireInstruction(consumer.upperProperty);
				const upperCall = requireInstruction(consumer.upperCall);
				const lowerProperty = requireInstruction(consumer.lowerProperty);
				const lowerCall = requireInstruction(consumer.lowerCall);
				const resultMoves = consumer.resultMoves.map((resultMove) => {
					const move = requireInstruction(resultMove);
					if (move.type !== "move") {
						throw new Error(`Core RegExp.exec plan ${selection.id} lost a move`);
					}
					return move;
				});
				const lengthProperty = requireInstruction(consumer.lengthProperty);
				if (
					upperProperty.type !== "loadPropertyStatic" ||
					upperCall.type !== "call" ||
					lowerProperty.type !== "loadPropertyStatic" ||
					lowerCall.type !== "call" ||
					lengthProperty.type !== "loadPropertyStatic"
				) {
					throw new Error(`Core RegExp.exec plan ${selection.id} lost ASCII case`);
				}
				return {
					instruction,
					key,
					captureIndex: load.captureIndex,
					consumer: {
						kind: "asciiCaseLength" as const,
						methodIdentity: consumer.methodIdentity,
						upperProperty,
						upperCall,
						lowerProperty,
						lowerCall,
						resultMoves,
						lengthProperty,
					},
				};
			});
			regions.push({
				...envelope(selection),
				anchors: [call, loads[0]!.instruction],
				kind: "regexp-exec-projection",
				license: {
					guard: regexp.guard,
					genericTwin: "retained",
					materialization: "whole-region",
					admission: admission(selection),
				},
				representation: "regexp-capture-spans",
				property,
				propertyPlacement: regexp.propertyPlacement,
				resultRegisters: regexp.resultValues.map(registerForValue),
				nullChecks,
				...(lockedLiteral === undefined ? {} : { lockedLiteral }),
				lastIndexEffect: "retained-call-twin",
				loads,
			});
			continue;
		}
		if (selection.kind === "regexp-iterator-projection") {
			const regexp = selection.regexpIteratorProjection;
			const step = requireInstruction(regexp.step);
			const doneBranch = requireInstruction(regexp.doneBranch);
			if (step.type !== "iteratorStep" || doneBranch.type !== "jumpIf") {
				throw new Error(`Core RegExp iterator plan ${selection.id} lost its step`);
			}
			const loads = regexp.loads.map((load) => {
				const instruction = requireInstruction(load.instruction);
				const key = requireInstruction(load.key);
				const numberIntrinsic = requireInstruction(load.numberIntrinsic);
				const numberCall = requireInstruction(load.numberCall);
				if (
					instruction.type !== "loadProperty" ||
					key.type !== "createNumber" ||
					numberIntrinsic.type !== "loadIntrinsic" ||
					numberCall.type !== "call"
				) {
					throw new Error(`Core RegExp iterator plan ${selection.id} lost a capture`);
				}
				return {
					instruction,
					key,
					captureIndex: load.captureIndex,
					numberIntrinsic,
					numberCall,
				};
			});
			regions.push({
				...envelope(selection),
				anchors: [step, doneBranch, loads[0]!.instruction],
				kind: "regexp-iterator-projection",
				license: {
					guard: regexp.guard,
					genericTwin: "retained",
					materialization: "on-demand",
					admission: admission(selection),
				},
				representation: "regexp-iterator-capture-spans",
				doneBranch,
				exitBlock: requireBlock(regexp.exitBlock),
				resultRegisters: regexp.resultValues.map(registerForValue),
				statefulEffect: "iterator-last-index-retained-step",
				runtimeGuard: "exact-brand-next-realm-regexp",
				loads,
			});
			continue;
		}
		if (selection.kind === "string-slice-number") {
			const slice = selection.stringSliceNumber;
			const property = requireInstruction(slice.property);
			const sliceCall = requireInstruction(slice.sliceCall);
			const start = requireInstruction(slice.sliceStartInstruction);
			const numberIntrinsic = requireInstruction(slice.numberIntrinsic);
			const numberCall = requireInstruction(slice.numberCall);
			if (
				property.type !== "loadPropertyStatic" ||
				sliceCall.type !== "call" ||
				(start.type !== "createNumber" && start.type !== "createF64") ||
				numberIntrinsic.type !== "loadIntrinsic" ||
				numberCall.type !== "call"
			) {
				throw new Error(`Core String.slice plan ${selection.id} lost its producers`);
			}
			regions.push({
				...envelope(selection),
				anchors: [sliceCall, numberCall],
				kind: "string-slice-number",
				license: {
					guard: slice.guard,
					genericTwin: "retained",
					materialization: "none",
					admission: admission(selection),
				},
				representation: "primitive-string-span-number",
				property,
				propertyPlacement: slice.propertyPlacement,
				builtinIdentities: slice.builtinIdentities,
				sliceStartInstruction: start,
				numberIntrinsic,
				numberCall,
				sliceStart: slice.sliceStart,
			});
			continue;
		}
		if (selection.kind === "string-char-code-at-chain") {
			const chain = selection.stringCharCodeAt;
			const property = requireInstruction(chain.property);
			const call = requireInstruction(chain.call);
			if (property.type !== "loadPropertyStatic" || call.type !== "call") {
				throw new Error(`Core String.charCodeAt plan ${selection.id} lost its call`);
			}
			regions.push({
				...envelope(selection),
				anchors: [property, call],
				kind: "string-char-code-at-chain",
				license: {
					guard: chain.guard,
					genericTwin: "retained",
					materialization: "none",
					admission: admission(selection),
				},
				representation: "primitive-string-code-unit",
				cost: { score: 12, metadataOperations: 2 },
				property,
				call,
				methodIdentity: chain.methodIdentity,
				runtimeGuard: "primitive-string-number-position",
				evaluationOrder: "capture-property-before-arguments",
			});
			continue;
		}
		if (selection.kind === "builtin-collection-call-chain") {
			const chain = selection.builtinCollectionCall;
			const property = requireInstruction(chain.property);
			const call = requireInstruction(chain.call);
			if (property.type !== "loadPropertyStatic" || call.type !== "call") {
				throw new Error(`Core collection plan ${selection.id} lost its call`);
			}
			regions.push({
				...envelope(selection),
				anchors: [property, call],
				kind: "builtin-collection-call-chain",
				license: {
					guard: chain.guard,
					genericTwin: "retained",
					materialization: "none",
					admission: admission(selection),
				},
				representation: "captured-collection-method",
				cost: { score: 14, metadataOperations: 2 },
				property,
				call,
				operation: chain.operation,
				runtimeGuard: "exact-collection-method",
				evaluationOrder: "capture-property-before-arguments",
			});
			continue;
		}
		if (selection.kind === "stack-object-plan") {
			const stack = selection.stackObject;
			const allocation = requireInstruction(stack.allocation);
			if (
				allocation.type !== "createObject" &&
				allocation.type !== "createObjectShaped"
			) {
				throw new Error(`Core stack-object plan ${selection.id} has no allocation`);
			}
			const accesses = stack.accesses.map(({ instruction, slot }) => {
				const lowered = requireInstruction(instruction);
				if (
					lowered.type !== "loadProperty" &&
					lowered.type !== "loadPropertyStatic" &&
					lowered.type !== "storeProperty" &&
					lowered.type !== "storePropertyStatic"
				) {
					throw new Error(`Core stack-object plan ${selection.id} has an invalid access`);
				}
				return { instruction: lowered, slot };
			});
			const materializations = stack.materializations.map(({ instruction }) => {
				const lowered = requireInstruction(instruction);
				if (lowered.type !== "return") {
					throw new Error(
						`Core stack-object plan ${selection.id} has an invalid materialization`,
					);
				}
				return { instruction: lowered, kind: "return" as const };
			});
			const materializes = materializations.length > 0;
			regions.push({
				...envelope(selection),
				anchors: [allocation],
				kind: "stack-object-plan",
				license: {
					guard: {
						dependencies: [],
						obligations: [
							{
								kind: "fallback",
								id: `${selection.id}:fallback`,
								cause: "escape",
							},
							...materializations.map((_, index) => ({
								kind: "materialize" as const,
								id: `${selection.id}:materialize:${index}`,
								cause: "escape" as const,
							})),
						],
					},
					genericTwin: "retained",
					materialization: materializes ? "on-demand" : "none",
					admission: admission(selection),
				},
				representation: "activation-local-fixed-shape-objects",
				cost: {
					score: Math.max(1, stack.slotCount),
					metadataOperations: selection.claimedInstructions.length,
				},
				sites: [
					{
						allocation,
						slotCount: stack.slotCount,
						accesses,
						materializations,
					},
				],
			});
			continue;
		}
		if (selection.kind === "dense-array-plan") continue;
		throw new Error("Core target encountered an unsupported specialization plan");
	}
	return regions;
}

export function coreRegisterClasses(
	fn: CoreFunctionStore,
	reuseRegisters = true,
	reservedAbiColors: ReadonlySet<number> = new Set(),
	blockOrder: ReadonlyArray<CoreBlockId> = [...fn.blockIds()],
): {
	readonly roots: ReadonlyMap<CoreValueId, CoreValueId>;
	readonly registers: ReadonlyMap<CoreValueId, number>;
	readonly registerRepresentations: ReadonlyMap<number, CoreRepresentation>;
} {
	const included = new Set(blockOrder);
	const uses = new Array<Set<CoreValueId>>(fn.blockCapacity);
	const definitions = new Array<Set<CoreValueId>>(fn.blockCapacity);
	const successors = new Array<Set<CoreBlockId>>(fn.blockCapacity);
	const predecessors = new Array<Array<CoreBlockId>>(fn.blockCapacity);
	const terminatorValues = new Array<ReadonlyArray<CoreValueId>>(fn.blockCapacity);
	const handlerParameters = (block: CoreBlockId): ReadonlyArray<CoreValueId> => {
		const handler = fn.blockHandler(block);
		if (handler === undefined || !included.has(handler.block)) return [];
		const parameters = fn.blockParameters(handler.block);
		if (parameters[0]?.role !== "exception") {
			throw new Error(`Core handler b${handler.block} has no exception parameter`);
		}
		const explicit = parameters.slice(1).map(({ value }) => value);
		if (explicit.length !== handler.arguments.length) {
			throw new Error(
				`Core handler b${handler.block} expects ${explicit.length} explicit arguments, received ${handler.arguments.length}`,
			);
		}
		return explicit;
	};
	for (const block of blockOrder) {
		uses[block] = new Set();
		definitions[block] = new Set();
		successors[block] = new Set();
		predecessors[block] = [];
	}
	for (const block of blockOrder) {
		const blockUses = uses[block]!;
		const blockDefinitions = definitions[block]!;
		for (const { value } of fn.blockParameters(block)) blockDefinitions.add(value);
		const addUse = (value: CoreValueId): void => {
			if (!blockDefinitions.has(value)) blockUses.add(value);
		};
		for (const instruction of fn.bodyInstructionIds(block)) {
			for (const input of fn.instructionOperands(instruction)) addUse(input);
			for (const output of fn.instructionResults(instruction))
				blockDefinitions.add(output);
		}
		const terminator = fn.terminatorPayload(fn.blockTerminator(block));
		const values: Array<CoreValueId> = coreTerminatorEdges(terminator).flatMap(
			({ arguments: edgeArguments }) => edgeArguments,
		);
		switch (terminator.kind) {
			case "branch":
			case "guard":
				values.unshift(terminator.condition);
				break;
			case "switch":
				values.unshift(terminator.discriminant);
				break;
			case "return":
			case "throw":
				values.unshift(terminator.value);
				break;
			case "jump":
			case "unreachable":
				break;
		}
		terminatorValues[block] = values;
		for (const value of values) addUse(value);
		for (const argument of fn.blockHandler(block)?.arguments ?? []) addUse(argument);
		for (const edge of coreTerminatorEdges(terminator)) {
			if (included.has(edge.block)) successors[block]!.add(edge.block);
		}
		const handler = fn.blockHandler(block);
		if (handler !== undefined && included.has(handler.block)) {
			successors[block]!.add(handler.block);
		}
	}
	for (const block of blockOrder) {
		for (const successor of successors[block]!) predecessors[successor]!.push(block);
	}
	const liveIn = new Array<Set<CoreValueId>>(fn.blockCapacity);
	const liveOut = new Array<Set<CoreValueId>>(fn.blockCapacity);
	const liveInOrder = new Array<Array<CoreValueId>>(fn.blockCapacity);
	for (const block of blockOrder) {
		liveIn[block] = new Set(uses[block]);
		liveOut[block] = new Set();
		liveInOrder[block] = [...liveIn[block]];
	}
	const pending = [...blockOrder];
	const queued = new Uint8Array(fn.blockCapacity);
	for (const block of blockOrder) queued[block] = 1;
	const propagated = new Uint32Array(fn.blockCapacity);
	while (pending.length > 0) {
		const block = pending.pop()!;
		queued[block] = 0;
		const order = liveInOrder[block]!;
		const start = propagated[block]!;
		propagated[block] = order.length;
		for (const predecessor of predecessors[block]!) {
			let changed = false;
			for (let index = start; index < order.length; index++) {
				const value = order[index]!;
				liveOut[predecessor]!.add(value);
				if (definitions[predecessor]!.has(value) || liveIn[predecessor]!.has(value)) {
					continue;
				}
				liveIn[predecessor]!.add(value);
				liveInOrder[predecessor]!.push(value);
				changed = true;
			}
			if (changed && queued[predecessor] === 0) {
				queued[predecessor] = 1;
				pending.push(predecessor);
			}
		}
	}

	interface LiveInterval {
		readonly value: CoreValueId;
		start: number;
		end: number;
		readonly blockRanges: Map<CoreBlockId, { start: number; end: number }>;
	}
	const intervals = new Array<LiveInterval | undefined>(fn.valueCapacity);
	const touch = (
		value: CoreValueId,
		block: CoreBlockId,
		position: number,
		blockPosition: number,
	): void => {
		let interval = intervals[value];
		if (interval === undefined) {
			interval = {
				value,
				start: position,
				end: position,
				blockRanges: new Map(),
			};
			intervals[value] = interval;
		} else {
			interval.start = Math.min(interval.start, position);
			interval.end = Math.max(interval.end, position);
		}
		const range = interval.blockRanges.get(block);
		if (range === undefined) {
			interval.blockRanges.set(block, { start: blockPosition, end: blockPosition });
		} else {
			range.start = Math.min(range.start, blockPosition);
			range.end = Math.max(range.end, blockPosition);
		}
	};
	let nextPosition = 0;
	for (const block of blockOrder) {
		const blockStart = nextPosition++;
		for (const { value } of fn.blockParameters(block)) touch(value, block, blockStart, 0);
		for (const value of liveIn[block]!) touch(value, block, blockStart, 0);
		const instructions = [...fn.bodyInstructionIds(block)];
		for (const [instructionIndex, instruction] of instructions.entries()) {
			const readPosition = nextPosition++;
			const writePosition = nextPosition++;
			for (const input of fn.instructionOperands(instruction))
				touch(input, block, readPosition, instructionIndex * 2 + 1);
			for (const output of fn.instructionResults(instruction))
				touch(output, block, writePosition, instructionIndex * 2 + 2);
		}
		const blockEnd = nextPosition++;
		const blockEndPosition = instructions.length * 2 + 1;
		for (const value of terminatorValues[block]!)
			touch(value, block, blockEnd, blockEndPosition);
		for (const argument of fn.blockHandler(block)?.arguments ?? [])
			touch(argument, block, blockEnd, blockEndPosition);
		for (const value of liveOut[block]!) touch(value, block, blockEnd, blockEndPosition);
		for (const parameter of handlerParameters(block)) {
			touch(parameter, block, blockStart, 0);
			touch(parameter, block, blockEnd, blockEndPosition);
		}
	}

	const roots = new Map<CoreValueId, CoreValueId>();
	const liveIntervals = intervals.filter(
		(interval): interval is LiveInterval => interval !== undefined,
	);
	for (const interval of liveIntervals) roots.set(interval.value, interval.value);
	const shapeCaseValues = new Set<CoreValueId>();
	for (const block of blockOrder) {
		for (const instruction of fn.bodyInstructionIds(block)) {
			if (fn.instructionOpcodeName(instruction) === "selectShapeCase") {
				for (const output of fn.instructionResults(instruction))
					shapeCaseValues.add(output);
			}
		}
	}
	const abi = new Map<CoreValueId, number>(
		fn.parameters.map((value, index) => [value, index]),
	);
	let snapshotIndex = 0;
	for (const instruction of fn.bodyInstructionIds(fn.entry)) {
		const opcode = fn.instructionOpcodeName(instruction);
		if (opcode !== "loadArgumentCount" && opcode !== "loadArgument") break;
		const output = fn.instructionResults(instruction)[0];
		if (output !== undefined) abi.set(output, fn.parameters.length + snapshotIndex++);
	}
	const registers = new Map<CoreValueId, number>();
	const registerRepresentations = new Map<number, CoreRepresentation>();
	const rangesByRegister = new Map<
		number,
		Map<CoreBlockId, Array<{ start: number; end: number }>>
	>();
	const addRanges = (register: number, interval: LiveInterval): void => {
		const byBlock =
			rangesByRegister.get(register) ??
			new Map<CoreBlockId, Array<{ start: number; end: number }>>();
		for (const [block, range] of interval.blockRanges) {
			const ranges = byBlock.get(block) ?? [];
			ranges.push({ ...range });
			ranges.sort((left, right) => left.start - right.start);
			byBlock.set(block, ranges);
		}
		rangesByRegister.set(register, byBlock);
	};
	const overlaps = (register: number, interval: LiveInterval): boolean => {
		const byBlock = rangesByRegister.get(register);
		if (byBlock === undefined) return false;
		for (const [block, range] of interval.blockRanges) {
			for (const candidate of byBlock.get(block) ?? []) {
				if (candidate.start > range.end) break;
				if (range.start <= candidate.end) return true;
			}
		}
		return false;
	};
	const assign = (interval: LiveInterval, register: number): void => {
		registers.set(interval.value, register);
		registerRepresentations.set(register, fn.valueRepresentation(interval.value));
		addRanges(register, interval);
	};
	for (const interval of liveIntervals) {
		const register = abi.get(interval.value);
		if (register !== undefined) assign(interval, register);
	}
	let nextUniqueRegister = Math.max(-1, ...registers.values()) + 1;
	const ordered = [...liveIntervals].sort(
		(left, right) =>
			left.start - right.start || left.end - right.end || left.value - right.value,
	);
	for (const interval of ordered) {
		if (registers.has(interval.value)) continue;
		const representation = fn.valueRepresentation(interval.value);
		let register = nextUniqueRegister;
		if (reuseRegisters && !shapeCaseValues.has(interval.value)) {
			register = 0;
			while (
				reservedAbiColors.has(register) ||
				(registerRepresentations.has(register) &&
					registerRepresentations.get(register) !== representation) ||
				overlaps(register, interval)
			) {
				register++;
			}
		}
		assign(interval, register);
		nextUniqueRegister = Math.max(nextUniqueRegister, register + 1);
	}
	return { roots, registers, registerRepresentations };
}

function lowerFunctionToTarget(
	coreFunction: CoreFunctionStore,
	executionFunction: number,
	functionMap: ExecutionFunctionMap,
	directEntryIds: ReadonlyMap<CoreInstructionId, number>,
	directEntryPlans: ReadonlyArray<CoreDirectEntryPlan>,
	specializationPlans: ReadonlyArray<CorePlanSpecialization>,
	blockOrder: ReadonlyArray<CoreBlockId>,
	siteFacts: ReadonlyMap<string, CompilerSiteFacts>,
	instructionSites: WeakMap<object, CompilerSiteFacts>,
	reuseRegisters: boolean,
): ExecutionFunction {
	const protectedInstructions = new Set(
		specializationPlans.flatMap(({ claimedInstructions }) => claimedInstructions),
	);
	const omittedInstructions = immediateOnlyInstructions(
		coreFunction,
		protectedInstructions,
	);
	const loweredBlockForCore = new Map<CoreBlockId, number>(
		blockOrder.map((block, index) => [block, index]),
	);
	const blocks: Array<{ instructions: Array<CompilerInstruction> }> = blockOrder.map(
		() => ({ instructions: [] }),
	);
	const loweredInstructions = new Map<CoreInstructionId, CompilerInstruction>();
	const guardedTargets = new Map<CoreInstructionId, ReadonlyArray<CoreFunctionId>>(
		specializationPlans
			.filter(({ kind }) => kind === "guarded-direct-call")
			.map((selection) => [selection.anchors[0]!, selection.targetFunctions]),
	);
	for (const entry of directEntryPlans) {
		for (const site of entry.callSites)
			guardedTargets.set(site.instruction, [entry.function]);
	}
	const denseReserveLengths = new Map<CoreInstructionId, number>();
	const plannedBuiltinCalls = new Map<CoreInstructionId, CoreAttributeValue>();
	const plannedExactCollectionReceivers = new Map<
		CoreInstructionId,
		CoreAttributeValue
	>();
	const plannedExactArrayLengths = new Map<CoreInstructionId, CoreAttributeValue>();
	const plannedDirectStringCharCodeAtPositions = new Map<
		CoreInstructionId,
		CoreAttributeValue
	>();
	const plannedPrimitiveStringLengths = new Map<CoreInstructionId, CoreAttributeValue>();
	const plannedDirectFunctionCalls = new Map<CoreInstructionId, CoreAttributeValue>();
	const plannedDirectCallTargets = new Map<CoreInstructionId, CoreAttributeValue>();
	for (const selection of specializationPlans) {
		if (selection.kind === "dense-array-plan") {
			denseReserveLengths.set(
				selection.denseArray.allocation,
				selection.denseArray.length,
			);
		}
		if (selection.kind === "string-split-projection") {
			plannedBuiltinCalls.set(
				selection.stringSplitProjection.call,
				selection.stringSplitProjection.builtinCall as unknown as CoreAttributeValue,
			);
		}
		if (selection.kind === "string-split-cursor") {
			plannedBuiltinCalls.set(
				selection.stringSplitCursor.call,
				selection.stringSplitCursor.splitBuiltinCall as unknown as CoreAttributeValue,
			);
			plannedBuiltinCalls.set(
				selection.stringSplitCursor.trimCall,
				selection.stringSplitCursor.trimBuiltinCall as unknown as CoreAttributeValue,
			);
			for (const length of selection.stringSplitCursor.primitiveStringLengths) {
				plannedPrimitiveStringLengths.set(length, true);
			}
		}
		if (selection.kind === "string-slice-number") {
			plannedBuiltinCalls.set(
				selection.stringSliceNumber.sliceCall,
				selection.stringSliceNumber.builtinCall as unknown as CoreAttributeValue,
			);
		}
		if (selection.kind === "regexp-exec-projection") {
			plannedBuiltinCalls.set(
				selection.regexpExecProjection.call,
				selection.regexpExecProjection.builtinCall as unknown as CoreAttributeValue,
			);
		}
		if (selection.kind === "string-char-code-at-chain") {
			plannedBuiltinCalls.set(
				selection.stringCharCodeAt.call,
				selection.stringCharCodeAt.builtinCall as unknown as CoreAttributeValue,
			);
			if (selection.stringCharCodeAt.bounded !== undefined) {
				plannedDirectStringCharCodeAtPositions.set(
					selection.stringCharCodeAt.call,
					"inBounds",
				);
				plannedPrimitiveStringLengths.set(
					selection.stringCharCodeAt.bounded.length,
					true,
				);
			}
		}
		if (selection.kind === "builtin-collection-call-chain") {
			plannedBuiltinCalls.set(
				selection.builtinCollectionCall.call,
				selection.builtinCollectionCall.builtinCall as unknown as CoreAttributeValue,
			);
			if (selection.builtinCollectionCall.exactReceiver !== undefined) {
				plannedExactCollectionReceivers.set(
					selection.builtinCollectionCall.call,
					selection.builtinCollectionCall.exactReceiver,
				);
			}
		}
		if (selection.kind === "fresh-array-length") {
			plannedExactArrayLengths.set(selection.freshArrayLength.load, true);
		}
		if (selection.kind === "function-call-chain") {
			plannedDirectFunctionCalls.set(selection.functionCall.call, true);
			if (selection.functionCall.targetFunction !== undefined) {
				plannedDirectCallTargets.set(
					selection.functionCall.call,
					selection.functionCall.targetFunction,
				);
			}
		}
	}

	const allocation = coreRegisterClasses(
		coreFunction,
		reuseRegisters,
		new Set(
			coreSupportsDirectEntries(coreFunction) ? coreFunction.parameters.keys() : [],
		),
		blockOrder,
	);
	const registerRepresentations = new Map(allocation.registerRepresentations);
	const allocatedRegisterCount = Math.max(-1, ...allocation.registers.values()) + 1;
	const nextRegister = { value: allocatedRegisterCount };
	const registerForValue = (value: CoreValueId): number => {
		const register = allocation.registers.get(allocation.roots.get(value) ?? value);
		if (register === undefined)
			throw new Error(`Core value %${value} has no execution register`);
		return register;
	};

	const parallelCopies: Array<ExecutionParallelCopy> = [];
	const temporaryRegisters: Array<number> = [];
	const edgeBlock = (edge: CoreEdge): number => {
		const targetBlock = loweredBlockForCore.get(edge.block);
		if (targetBlock === undefined) {
			throw new Error(`Core edge targets unreachable block b${edge.block}`);
		}
		const parameters = coreFunction.blockParameters(edge.block);
		if (parameters[0]?.role === "exception") {
			throw new Error(`Ordinary Core edge targets exception block b${edge.block}`);
		}
		const assignments = parameters.map((parameter, index) => ({
			destination: registerForValue(parameter.value),
			source: registerForValue(edge.arguments[index]!),
		}));
		const copy = parallelMoves(assignments, nextRegister, registerRepresentations);
		if (copy.moves.length === 0) return targetBlock;
		parallelCopies.push({ kind: "edge", assignments, ...copy });
		temporaryRegisters.push(...copy.temporaries);
		const block = blocks.length;
		blocks.push({
			instructions: [...copy.moves, { type: "jump", blocks: [targetBlock] }],
		});
		return block;
	};

	const pendingOperationSafepoints: Array<
		Omit<Extract<ExecutionSafepoint, { kind: "operation" }>, "rootRegisters">
	> = [];
	for (const blockId of blockOrder) {
		const loweredBlock = loweredBlockForCore.get(blockId)!;
		const instructions = blocks[loweredBlock]!.instructions;
		const handler = coreFunction.blockHandler(blockId);
		if (handler !== undefined) {
			const targetBlock = loweredBlockForCore.get(handler.block);
			if (targetBlock === undefined) {
				throw new Error(`Core handler targets unreachable block b${handler.block}`);
			}
			const parameters = coreFunction.blockParameters(handler.block);
			if (parameters[0]?.role !== "exception") {
				throw new Error(`Core handler b${handler.block} has no exception parameter`);
			}
			instructions.push({ type: "tryBegin", blocks: [targetBlock, loweredBlock] });
			const assignments = parameters.slice(1).map((parameter, index) => ({
				destination: registerForValue(parameter.value),
				source: registerForValue(handler.arguments[index]!),
			}));
			const copy = parallelMoves(assignments, nextRegister, registerRepresentations);
			if (copy.moves.length > 0) {
				parallelCopies.push({ kind: "handler-input", assignments, ...copy });
				temporaryRegisters.push(...copy.temporaries);
			}
			instructions.push(...copy.moves);
		}
		const parameters = coreFunction.blockParameters(blockId);
		if (parameters[0]?.role === "exception") {
			instructions.push({
				type: "catch",
				registers: [registerForValue(parameters[0].value)],
			});
		}

		for (const instruction of coreFunction.bodyInstructionIds(blockId)) {
			if (omittedInstructions.has(instruction)) continue;
			instructions.push(
				...sourcePositionMarker(coreFunction.instructionSourcePosition(instruction)),
			);
			const rebuilt = rebuildOperation(
				coreFunction,
				instruction,
				registerForValue,
				functionMap,
				directEntryIds.get(instruction),
				guardedTargets.get(instruction),
				plannedBuiltinCalls.get(instruction),
				plannedExactCollectionReceivers.get(instruction),
				plannedExactArrayLengths.get(instruction),
				plannedDirectStringCharCodeAtPositions.get(instruction),
				plannedPrimitiveStringLengths.get(instruction),
				plannedDirectFunctionCalls.get(instruction),
				plannedDirectCallTargets.get(instruction),
				!protectedInstructions.has(instruction),
			);
			const reserveLength = denseReserveLengths.get(instruction);
			if (reserveLength !== undefined && rebuilt.type !== "createArray") {
				throw new Error(`Core dense-array plan lost allocation @${instruction}`);
			}
			let lowered: CompilerInstruction = rebuilt;
			if (reserveLength !== undefined && rebuilt.type === "createArray") {
				lowered = { ...rebuilt, freshDenseReserveLength: reserveLength };
			}
			loweredInstructions.set(instruction, lowered);
			const site = siteFacts.get(
				coreCompilerSiteId(
					coreFunction.id,
					blockId,
					instruction,
					coreFunction.instructionOpcodeName(instruction),
				),
			);
			if (site !== undefined) instructionSites.set(lowered, site);
			let resultMove: CompilerInstruction | undefined;
			const twoAddress = COMPILER_TWO_ADDRESS_OPERANDS[lowered.type];
			if (twoAddress !== undefined) {
				const registers = (lowered as { readonly registers: Array<number> }).registers;
				const destination = registers[twoAddress.result]!;
				const operand = registers[twoAddress.operand]!;
				if (destination !== operand) {
					const constrained = nextRegister.value++;
					registerRepresentations.set(constrained, "boxed");
					temporaryRegisters.push(constrained);
					instructions.push({ type: "move", registers: [constrained, operand] });
					registers[twoAddress.result] = constrained;
					registers[twoAddress.operand] = constrained;
					resultMove = { type: "move", registers: [destination, constrained] };
				}
			}
			instructions.push(lowered);
			if (resultMove !== undefined) instructions.push(resultMove);
			const realizedCoreInstructions = new Set<CoreInstructionId>();
			if (coreInstructionNeedsOperationSafepoint(coreFunction, instruction)) {
				realizedCoreInstructions.add(instruction);
			}
			const immediateValues = (
				lowered as { readonly immediateValues?: ReadonlyArray<unknown> }
			).immediateValues;
			for (const [index, input] of coreFunction
				.instructionOperands(instruction)
				.entries()) {
				if (
					immediateValues?.[
						coreFunction.instructionResults(instruction).length + index
					] === undefined
				) {
					continue;
				}
				const definition = coreFunction.valueDefinition(input);
				if (
					definition.kind === "instruction" &&
					omittedInstructions.has(definition.instruction) &&
					coreInstructionNeedsOperationSafepoint(coreFunction, definition.instruction)
				) {
					realizedCoreInstructions.add(definition.instruction);
				}
			}
			if (realizedCoreInstructions.size > 0) {
				pendingOperationSafepoints.push({
					kind: "operation",
					coreInstruction: instruction,
					realizedCoreInstructions: [...realizedCoreInstructions],
					instruction: lowered,
				});
			}
		}

		const terminatorId = coreFunction.blockTerminator(blockId);
		const terminator = coreFunction.terminatorPayload(terminatorId);
		instructions.push(
			...sourcePositionMarker(coreFunction.instructionSourcePosition(terminatorId)),
		);
		switch (terminator.kind) {
			case "jump": {
				const lowered: Extract<CompilerInstruction, { type: "jump" }> = {
					type: "jump",
					blocks: [edgeBlock(terminator.edge)],
				};
				instructions.push(lowered);
				loweredInstructions.set(terminatorId, lowered);
				break;
			}
			case "branch": {
				const lowered: Extract<CompilerInstruction, { type: "jumpIf" }> = {
					type: "jumpIf",
					registers: [registerForValue(terminator.condition)],
					blocks: [edgeBlock(terminator.consequent)],
				};
				instructions.push(lowered, {
					type: "jump",
					blocks: [edgeBlock(terminator.alternate)],
				});
				loweredInstructions.set(terminatorId, lowered);
				break;
			}
			case "guard":
				instructions.push(
					{
						type: "jumpIf",
						registers: [registerForValue(terminator.condition)],
						blocks: [edgeBlock(terminator.success)],
					},
					{ type: "jump", blocks: [edgeBlock(terminator.fallback)] },
				);
				break;
			case "return":
			case "throw": {
				const lowered: Extract<CompilerInstruction, { type: "return" | "throw" }> = {
					type: terminator.kind,
					registers: [registerForValue(terminator.value)],
				};
				instructions.push(lowered);
				loweredInstructions.set(terminatorId, lowered);
				break;
			}
			case "switch":
				for (const switchCase of terminator.cases) {
					const immediate = nextRegister.value++;
					const matches = nextRegister.value++;
					temporaryRegisters.push(immediate, matches);
					registerRepresentations.set(
						immediate,
						switchCase.value.kind === "number"
							? "f64"
							: switchCase.value.kind === "boolean"
								? "boolean"
								: "boxed",
					);
					registerRepresentations.set(matches, "boolean");
					instructions.push(
						lowerCoreImmediate(switchCase.value, immediate),
						{
							type: "binary",
							registers: [matches, registerForValue(terminator.discriminant), immediate],
							operator: "===",
						},
						{
							type: "jumpIf",
							registers: [matches],
							blocks: [edgeBlock(switchCase.edge)],
						},
					);
				}
				instructions.push({
					type: "jump",
					blocks: [edgeBlock(terminator.default)],
				});
				break;
			case "unreachable":
				throw new Error(`Reachable Core block b${blockId} ends in unreachable`);
		}
		if (handler !== undefined) instructions.push({ type: "tryEnd" });
	}

	const physicalRepresentations = Array.from(
		{ length: nextRegister.value },
		(_, register): ExecutionRegisterRepresentation => {
			const representation = registerRepresentations.get(register);
			if (representation === undefined) {
				throw new Error(`Execution register r${register} has no representation`);
			}
			return coreFunction.isGenerator || coreFunction.isAsync
				? "boxed"
				: physicalRegisterClass(representation);
		},
	);
	const specializations = lowerCoreSpecializations(
		coreFunction,
		specializationPlans,
		loweredInstructions,
		loweredBlockForCore,
		registerForValue,
	);
	const fnWithoutGc: Omit<ExecutionFunction, "gc"> = {
		sourcePath: coreFunction.metadata.sourcePath,
		functionIndex: executionFunction,
		nameStringIndex: coreFunction.metadata.nameStringIndex,
		blocks,
		coreBlocks: Object.freeze([...blockOrder]),
		specializations,
		isGenerator: coreFunction.isGenerator,
		isAsync: coreFunction.isAsync,
		parameterCount: coreFunction.parameters.length,
		mappedArgumentSlots: [...coreFunction.metadata.mappedArgumentSlots],
		mappedArguments: coreFunction.metadata.mappedArguments,
		length: coreFunction.metadata.length,
		registerCount: nextRegister.value,
		allocatedRegisterCount,
		registerRepresentations: physicalRepresentations,
		directEntries: [],
		capturedCount: coreFunction.metadata.capturedCount,
		strict: coreFunction.metadata.strict,
		isClassConstructor: coreFunction.metadata.isClassConstructor,
		isDerivedConstructor: coreFunction.metadata.isDerivedConstructor,
		hasPrototype: coreFunction.metadata.hasPrototype,
		parallelCopies,
		temporaryRegisters,
	};
	const analysisFunction: ExecutionFunction = {
		...fnWithoutGc,
		gc: { safepoints: [] },
	};
	const pendingSafepoints = [
		...pendingOperationSafepoints,
		...[...executionLoopBackedgeInstructions(analysisFunction)].map((instruction) => ({
			kind: "loop-backedge" as const,
			instruction,
		})),
	];
	const roots = executionSafepointRootRegisters(
		analysisFunction,
		new Set(pendingSafepoints.map(({ instruction }) => instruction)),
	);
	const instructionOrder = new Map<CompilerInstruction, number>();
	let order = 0;
	for (const block of blocks) {
		for (const instruction of block.instructions)
			instructionOrder.set(instruction, order++);
	}
	const safepoints: Array<ExecutionSafepoint> = pendingSafepoints
		.map((safepoint) => ({
			...safepoint,
			rootRegisters: roots.get(safepoint.instruction) ?? [],
		}))
		.sort(
			(left, right) =>
				instructionOrder.get(left.instruction)! -
				instructionOrder.get(right.instruction)!,
		);
	const directEntries = directEntryPlans.map((entry) => ({
		id: entry.id,
		parameterRepresentations: entry.parameterRepresentations.map(
			planExecutionRepresentation,
		),
		resultRepresentation: planExecutionRepresentation(entry.resultRepresentation),
		registerRepresentations: physicalRepresentations,
		gc: { safepoints },
	}));
	return { ...fnWithoutGc, directEntries, gc: { safepoints } };
}

function planExecutionRepresentation(
	representation: CorePlanRepresentation,
): ExecutionRegisterRepresentation {
	if (representation === "f64") return "number";
	if (representation === "i32") return "int32";
	return representation;
}

/** Lower sealed Core directly into the generic runtime execution contract. */
export function lowerCoreCompilationToExecutionProgram(
	compilation: CoreCompilation,
	options: LowerCoreToExecutionOptions = {},
): ExecutionProgram {
	assertCoreOptimizationPlanCertificate(compilation.program, compilation.plan);
	const functionMap = createExecutionFunctionMap(compilation);
	const directEntryPlans = new Map<number, Array<CoreDirectEntryPlan>>();
	const directEntryIds = new Map<number, Map<CoreInstructionId, number>>();
	const specializationPlans = new Map<number, Array<CorePlanSpecialization>>();
	const blockOrders = new Map(
		compilation.plan.blockOrders.map(({ function: functionId, blocks }) => [
			functionId,
			blocks,
		]),
	);
	for (const specialization of compilation.plan.specializations) {
		const selections = specializationPlans.get(specialization.function) ?? [];
		selections.push(specialization);
		specializationPlans.set(specialization.function, selections);
	}
	for (const entry of compilation.plan.directEntries) {
		const entries = directEntryPlans.get(entry.function) ?? [];
		entries.push(entry);
		directEntryPlans.set(entry.function, entries);
		for (const site of entry.callSites) {
			const calls =
				directEntryIds.get(site.caller) ?? new Map<CoreInstructionId, number>();
			calls.set(site.instruction, entry.id);
			directEntryIds.set(site.caller, calls);
		}
	}
	const functions = functionMap.executionToCore.map((core, execution) =>
		lowerFunctionToTarget(
			compilation.program.function(core),
			execution,
			functionMap,
			directEntryIds.get(core) ?? new Map(),
			directEntryPlans.get(core) ?? [],
			specializationPlans.get(core) ?? [],
			blockOrders.get(core)!,
			compilation.context.facts.sites,
			compilation.context.facts.instructionSites,
			options.reuseRegisters !== false,
		),
	);
	return Object.freeze({
		core: compilation.program,
		context: compilation.context,
		functionMap,
		functions: Object.freeze(functions),
	});
}

export function lowerCoreCompilationToRuntimeExecution(
	compilation: CoreCompilation,
	options: LowerCoreToExecutionOptions = {},
): ExecutionProgram {
	const program = lowerCoreCompilationToExecutionProgram(compilation, options);
	verifyExecutionProgram(program);
	return program;
}
