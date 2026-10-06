import { coreCompilerSiteId } from "../core/compiler-site-facts.ts";
import type { CoreCompilation } from "../core/core-compilation.ts";
import { coreConstructorSlotReserve } from "../core/core-constructor-layout.ts";
import {
	CORE_CONTAINED_DENSE_ARRAY_ELEMENT_ATTRIBUTE,
	CORE_EXACT_BINARY_INPUT_KIND_MASKS_ATTRIBUTE,
	CORE_EXACT_CALL_ARGUMENT_REPRESENTATIONS_ATTRIBUTE,
	CORE_EXACT_COLLECTION_RECEIVER_ATTRIBUTE,
	CORE_EXACT_SCALAR_AFTER_TDZ_ATTRIBUTE,
	CORE_EXACT_SHAPE_OWN_SLOT_ATTRIBUTE,
	CORE_FRESH_ARRAY_LENGTH_ATTRIBUTE,
	CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE,
} from "../core/core-internal-attributes.ts";
import type {
	CoreAllocatedRegion,
	CoreDirectEntryPlan,
	CorePlanRepresentation,
} from "../core/core-ir-regions.ts";
import { coreInstructionId } from "../core/core-ir.ts";
import type {
	CoreBlockId,
	CoreAttributeValue,
	CoreFunctionId,
	CoreImmediate,
	CoreInstructionAttributes,
	CoreInstructionId,
	CoreRepresentation,
	CoreValueId,
} from "../core/core-ir.ts";
import type { CorePrivatePackedRestArrayElementPlan } from "../core/core-native-numeric-analysis.ts";
import { assertCoreOptimizationPlanCertificate } from "../core/core-optimization-plan-certificate.ts";
import {
	coreSpecializationRecipeAdmissionAt,
	coreSpecializationRecipeAnchorsAt,
	coreSpecializationRecipeClaimsAt,
	coreSpecializationRecipeExceptionalBlocksAt,
	coreSpecializationRecipeFunctionAt,
	coreSpecializationRecipeIdAt,
	coreSpecializationRecipeKindAt,
	coreSpecializationRecipeOrdinaryBlocksAt,
	coreSpecializationRecipePayloadAt,
	coreSpecializationRecipeRepresentationAt,
	coreSpecializationRecipeTargetFunctionsAt,
} from "../core/core-specialization-recipes.ts";
import type { CoreSpecializationRecipeTable } from "../core/core-specialization-recipes.ts";
import type { CoreFunctionStore } from "../core/core-store.ts";
import type { CompilerSiteFacts } from "../shared/compiler-facts.ts";
import { COMPILER_TWO_ADDRESS_OPERANDS } from "../shared/compiler-instruction.ts";
import type {
	CompilerImmediateValue,
	CompilerInstruction,
	CompilerNumericSortCallback,
} from "../shared/compiler-instruction.ts";
import type { CompilerOperatorInputKindMasks } from "../shared/compiler-value-kinds.ts";
import { NATIVE_STRING_SWITCH_CASE_LIMIT } from "../shared/native-string-switch.ts";
import {
	coreInstructionNeedsOperationSafepoint,
	requireCoreTargetOperationContract,
} from "./core-operation-contract.ts";
import type {
	CoreTargetFunction,
	CoreTargetFunctionMap,
	CoreTargetMove,
	CoreTargetParallelCopy,
	CoreTargetProgram,
	CoreTargetRegisterRepresentation,
	CoreTargetSafepoint,
	CoreTargetSafepointRoots,
} from "./core-target-ir.ts";
import { coreTargetFunctionIndex } from "./core-target-ir.ts";
import {
	executionLoopBackedgeInstructions,
	executionSafepointRoots,
} from "./execution-liveness.ts";

export type {
	CoreTargetFunction,
	CoreTargetMove,
	CoreTargetParallelCopy,
	CoreTargetProgram,
	CoreTargetSafepoint,
} from "./core-target-ir.ts";

export interface LowerCoreToCoreTargetOptions {
	readonly assignStorage: CoreStorageAssigner;
	readonly createParallelCopyLowerer?: (
		nextRegister: { value: number },
		representations: Map<number, CoreRepresentation>,
		canonicalRepresentations: ReadonlyMap<number, CoreTargetRegisterRepresentation>,
		variants: ReadonlyArray<ReadonlyMap<number, CoreTargetRegisterRepresentation>>,
	) => CoreParallelCopyLowerer;
	readonly layoutBlocks?: (
		blocks: CoreTargetFunction["blocks"],
		coreBlockCount: number,
	) => ReadonlyArray<number>;
	readonly loopBackedgeInstructions?: typeof executionLoopBackedgeInstructions;
	readonly excludeGuardedDirectCalls?: boolean;
	readonly preserveResumableRepresentations?: boolean;
}

export interface CoreStorageAssignment {
	readonly roots: ReadonlyMap<CoreValueId, CoreValueId>;
	readonly registers: ReadonlyMap<CoreValueId, number>;
	readonly registerRepresentations: ReadonlyMap<number, CoreRepresentation>;
	readonly storageValues?: ReadonlyArray<number>;
}
export type CoreStorageAssigner = (
	fn: CoreFunctionStore,
	blockOrder: ReadonlyArray<CoreBlockId>,
	reservedAbiColors: ReadonlySet<number>,
	variantRepresentations: ReadonlyArray<ReadonlyArray<CorePlanRepresentation>>,
) => CoreStorageAssignment;

export interface LoweredParallelCopy {
	readonly moves: Array<CoreTargetMove>;
	readonly temporaries: Array<number>;
}

export interface CoreParallelCopyLowerer {
	readonly lower: (
		assignments: CoreTargetParallelCopy["assignments"],
	) => LoweredParallelCopy;
	readonly temporaryRepresentations: ReadonlyMap<
		number,
		ReadonlyArray<CoreTargetRegisterRepresentation>
	>;
}

const REGISTERLESS_CORE_OPERATIONS: ReadonlySet<string> = new Set([
	"asyncStart",
	"createPrivateNames",
	"envCopy",
	"envPop",
	"envPush",
	"generatorStart",
	"declareGlobalLexical",
	"initGlobalVars",
]);

const RAW_ARGUMENT_OPCODES: ReadonlySet<string> = new Set([
	"loadArgumentCount",
	"loadArgument",
	"loadStaticArgument",
	"createArgumentsObject",
	"createRestArguments",
	"callRestArguments",
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
	"methodFunctionIndex",
	"directFunctionIndex",
	"directCallTargetFunctionIndex",
	"directCallbackFunctionIndex",
	"numericSortCallback",
]);

const CORE_INTERNAL_ATTRIBUTES: ReadonlySet<string> = new Set([
	"sourceCall",
	CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE,
	CORE_CONTAINED_DENSE_ARRAY_ELEMENT_ATTRIBUTE,
	CORE_FRESH_ARRAY_LENGTH_ATTRIBUTE,
	CORE_EXACT_COLLECTION_RECEIVER_ATTRIBUTE,
	CORE_EXACT_BINARY_INPUT_KIND_MASKS_ATTRIBUTE,
	CORE_EXACT_CALL_ARGUMENT_REPRESENTATIONS_ATTRIBUTE,
	CORE_EXACT_SCALAR_AFTER_TDZ_ATTRIBUTE,
	CORE_EXACT_SHAPE_OWN_SLOT_ATTRIBUTE,
	"directStringCharCodeAtPosition",
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
	const moves: Array<CoreTargetMove> = [];
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
): CoreTargetRegisterRepresentation {
	if (representation === "i32") return "int32";
	if (representation === "f64") return "number";
	if (representation === "boolean") return "boolean";
	return representation === "string" ? "string" : "boxed";
}

function createCoreTargetFunctionMap(
	compilation: CoreCompilation,
): CoreTargetFunctionMap {
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
	map: CoreTargetFunctionMap,
): CoreInstructionAttributes {
	let changed = false;
	const relocated: Record<string, CoreAttributeValue> = { ...attributes };
	for (const key of FUNCTION_INDEX_ATTRIBUTES) {
		const value = attributes[key];
		if (typeof value !== "number" || value < 0) continue;
		relocated[key] = coreTargetFunctionIndex(map, value);
		changed = true;
	}
	const guarded = attributes.guardedFunctionIndices;
	if (isCoreAttributeArray(guarded)) {
		relocated.guardedFunctionIndices = guarded.map((value) =>
			typeof value === "number" ? coreTargetFunctionIndex(map, value) : value,
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
			return {
				type: "createBoolean",
				registers: [destination],
				value: value.value,
			};
		case "number":
			return {
				type: "createNumber",
				registers: [destination],
				value: value.value,
			};
		case "string":
			return {
				type: "createString",
				registers: [destination],
				stringIndex: value.index,
			};
	}
}

function coreImmediateValue(
	fn: CoreFunctionStore,
	value: CoreValueId,
): CompilerImmediateValue | undefined {
	const kernel = fn.kernel;
	if (
		kernel.valueDefinitionKind(value) !== 1 ||
		kernel.valueDefinitionIndex(value) !== 0
	) {
		return undefined;
	}
	const instruction = kernel.valueDefinitionOwner(value) as CoreInstructionId;
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
	const kernel = fn.kernel;
	const embedded = new Set<CoreValueId>();
	const ordinary = new Set<CoreValueId>();
	for (const block of fn.blockIds()) {
		for (const instruction of fn.bodyInstructionIds(block)) {
			const embeddable =
				!protectedInstructions.has(instruction) &&
				["call", "callKnown", "construct"].includes(
					fn.instructionOpcodeName(instruction),
				);
			const inputStart = kernel.instructionOperandStart(instruction);
			const inputCount = kernel.instructionOperandCount(instruction);
			for (let index = 0; index < inputCount; index++) {
				const input = kernel.operandAt(inputStart + index);
				if (embeddable && coreImmediateValue(fn, input) !== undefined) {
					embedded.add(input);
				} else {
					ordinary.add(input);
				}
			}
		}
		const terminator = fn.blockTerminator(block);
		const terminatorOperandStart = kernel.instructionOperandStart(terminator);
		const terminatorOperandCount = kernel.instructionOperandCount(terminator);
		for (let index = 0; index < terminatorOperandCount; index++) {
			ordinary.add(kernel.operandAt(terminatorOperandStart + index));
		}
		const handlerArgumentStart = kernel.blockHandlerArgumentStart(block);
		const handlerArgumentCount = kernel.blockHandlerArgumentCount(block);
		for (let index = 0; index < handlerArgumentCount; index++) {
			ordinary.add(kernel.handlerArgumentAt(handlerArgumentStart + index));
		}
	}
	const omitted = new Set<CoreInstructionId>();
	for (const block of fn.blockIds()) {
		for (const instruction of fn.bodyInstructionIds(block)) {
			if (protectedInstructions.has(instruction)) continue;
			const resultStart = kernel.instructionResultStart(instruction);
			const resultCount = kernel.instructionResultCount(instruction);
			if (resultCount === 0) continue;
			let allEmbedded = true;
			for (let index = 0; index < resultCount; index++) {
				const result = kernel.resultAt(resultStart + index);
				if (!embedded.has(result) || ordinary.has(result)) {
					allEmbedded = false;
					break;
				}
			}
			if (allEmbedded) omitted.add(instruction);
		}
	}
	return omitted;
}

function rebuildOperation(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	registerForValue: (value: CoreValueId) => number,
	functionMap: CoreTargetFunctionMap,
	directEntryId: number | undefined,
	guardedTargets: ReadonlyArray<CoreFunctionId> | undefined,
	exactCallTarget: boolean,
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
		if (exactCallTarget) {
			selectedAttributes.directFunctionIndex = guardedTargets[0]!;
		} else {
			selectedAttributes.guardedFunctionIndices = guardedTargets;
		}
	}
	const attributes = relocateFunctionReferences(selectedAttributes, functionMap);
	const kernel = fn.kernel;
	const outputStart = kernel.instructionResultStart(instruction);
	const outputCount = kernel.instructionResultCount(instruction);
	const inputStart = kernel.instructionOperandStart(instruction);
	const inputCount = kernel.instructionOperandCount(instruction);
	const registers = new Array<number>(outputCount + inputCount);
	for (let index = 0; index < outputCount; index++) {
		registers[index] = registerForValue(kernel.resultAt(outputStart + index));
	}
	for (let index = 0; index < inputCount; index++) {
		registers[outputCount + index] = registerForValue(
			kernel.operandAt(inputStart + index),
		);
	}
	const immediateValues: Array<CompilerImmediateValue | undefined> = [];
	if (
		allowImmediateOperands &&
		(opcode === "call" || opcode === "callKnown" || opcode === "construct")
	) {
		for (let index = 0; index < inputCount; index++) {
			const input = kernel.operandAt(inputStart + index);
			const immediate = coreImmediateValue(fn, input);
			if (immediate === undefined) continue;
			const position = outputCount + index;
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
	recipeTable: CoreSpecializationRecipeTable,
	recipeRows: ReadonlyArray<number>,
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
	const envelope = (row: number) => {
		const claims = coreSpecializationRecipeClaimsAt(recipeTable, row);
		return {
			anchors: coreSpecializationRecipeAnchorsAt(recipeTable, row).map(
				requireInstruction,
			),
			claimedInstructions: claims.map(requireInstruction),
			controlFlow: {
				ordinaryBlocks: coreSpecializationRecipeOrdinaryBlocksAt(recipeTable, row).map(
					requireBlock,
				),
				exceptionalBlocks: coreSpecializationRecipeExceptionalBlocksAt(
					recipeTable,
					row,
				).map(requireBlock),
			},
			cost: {
				score: claims.length - 1,
				metadataOperations: claims.length,
			},
		};
	};
	const admission = (row: number) => {
		const plan = coreSpecializationRecipeAdmissionAt(recipeTable, row);
		if (plan === undefined)
			throw new Error(
				`Core recipe ${coreSpecializationRecipeIdAt(recipeTable, row)} has no admission`,
			);
		return { anchor: requireInstruction(plan.anchor), mode: plan.mode };
	};
	const regions: Array<CoreAllocatedRegion> = [];
	for (const row of recipeRows) {
		const kind = coreSpecializationRecipeKindAt(recipeTable, row);
		const id = coreSpecializationRecipeIdAt(recipeTable, row);
		const anchors = coreSpecializationRecipeAnchorsAt(recipeTable, row);
		const claims = coreSpecializationRecipeClaimsAt(recipeTable, row);
		if (
			kind === "guarded-direct-call" ||
			kind === "fresh-array-length" ||
			kind === "function-call-chain"
		)
			continue;
		const anchor = anchors[0]!;
		const loweredAnchor = requireInstruction(anchor);
		if (kind === "numeric-fusion") {
			if (loweredAnchor.type !== "binary") {
				throw new Error(`Core numeric plan ${id} does not lower to binary`);
			}
			const result =
				fn.kernel.instructionResultCount(anchor) === 0
					? undefined
					: fn.kernel.resultAt(fn.kernel.instructionResultStart(anchor));
			if (result === undefined) {
				throw new Error(`Core numeric plan ${id} has no result`);
			}
			const pairs = claims.slice(1).map((instruction) => {
				const lowered = requireInstruction(instruction);
				const operandStart = fn.kernel.instructionOperandStart(instruction);
				const operandCount = fn.kernel.instructionOperandCount(instruction);
				let input = -1;
				for (let index = 0; index < operandCount; index++) {
					if (fn.kernel.operandAt(operandStart + index) === result) {
						input = index;
						break;
					}
				}
				if (lowered.type !== "binary" || (input !== 0 && input !== 1)) {
					throw new Error(`Core numeric plan ${id} has an invalid finish`);
				}
				return {
					first: loweredAnchor,
					finish: lowered,
					firstUsePosition: (input + 1) as 1 | 2,
				};
			});
			if (pairs.length === 0) {
				throw new Error(`Core numeric plan ${id} has no fused pair`);
			}
			regions.push({
				...envelope(row),
				anchors: [loweredAnchor, pairs[0]!.finish],
				kind: "numeric-fusion",
				license: {
					guard: "structural",
					genericTwin: "retained",
					materialization: "none",
					admission: admission(row),
				},
				representation:
					coreSpecializationRecipeRepresentationAt(recipeTable, row) ===
					"binary-pairs-truncating-i32"
						? "binary-pairs-truncating-i32"
						: "binary-pairs-f64",
				composition: "overlay",
				runtimeGuard:
					coreSpecializationRecipeRepresentationAt(recipeTable, row) ===
					"binary-pairs-truncating-i32"
						? "int32-operands"
						: "number-operands",
				pairs,
			});
			continue;
		}
		if (kind === "indexed-length-loop") {
			const indexed = coreSpecializationRecipePayloadAt(
				recipeTable,
				row,
				"indexed-length-loop",
				"indexedLengthLoop",
			);
			const load = requireInstruction(indexed.load);
			const comparison = requireInstruction(indexed.comparison);
			if (load.type !== "loadPropertyStatic" || comparison.type !== "binary") {
				throw new Error(`Core indexed-length plan ${id} lost its anchors`);
			}
			const elements = indexed.elements.map((element) => {
				const instruction = requireInstruction(element.instruction);
				const index =
					element.index === undefined ? undefined : requireInstruction(element.index);
				if (
					(element.kind === "load" && instruction.type !== "loadProperty") ||
					(element.kind === "store" && instruction.type !== "storeProperty") ||
					(index !== undefined && index.type !== "binary")
				) {
					throw new Error(`Core indexed-length plan ${id} lost an element`);
				}
				return {
					instruction: instruction as Extract<
						CompilerInstruction,
						{ type: "loadProperty" | "storeProperty" }
					>,
					kind: element.kind,
					arrayIndexIsUint32: element.arrayIndexIsUint32,
					...(index === undefined
						? {}
						: {
								index,
							}),
				};
			});
			const reverseInduction =
				indexed.reverseInduction === undefined
					? undefined
					: {
							coercion: requireInstruction(indexed.reverseInduction.coercion),
							update: requireInstruction(indexed.reverseInduction.update),
						};
			if (
				reverseInduction !== undefined &&
				(reverseInduction.coercion.type !== "unary" ||
					reverseInduction.update.type !== "unary")
			) {
				throw new Error(`Core indexed-length plan ${id} lost its reverse induction`);
			}
			regions.push({
				...envelope(row),
				anchors: [load, comparison],
				kind: "indexed-length-loop",
				license: {
					guard: "structural",
					genericTwin: "retained",
					materialization: "none",
					admission: admission(row),
				},
				representation: "live-indexed-length-loops",
				cost: {
					score: 4 + elements.length * 3 + (reverseInduction === undefined ? 0 : 4),
					metadataOperations:
						2 +
						elements.length +
						elements.filter(({ index }) => index !== undefined).length +
						(reverseInduction === undefined ? 0 : 2),
				},
				runtimeGuard: "array-or-numeric-typed-array",
				sites: [
					{
						load,
						comparison,
						lengthPosition: indexed.lengthPosition,
						...(reverseInduction === undefined
							? {}
							: {
									reverseInduction: {
										coercion: reverseInduction.coercion as Extract<
											CompilerInstruction,
											{ type: "unary" }
										>,
										update: reverseInduction.update as Extract<
											CompilerInstruction,
											{ type: "unary" }
										>,
									},
								}),
						elements,
					},
				],
			});
			continue;
		}
		if (
			kind === "array-values-iterator-cursor" ||
			kind === "string-iterator-cursor" ||
			kind === "typed-array-iterator-cursor" ||
			kind === "map-iterator-cursor" ||
			kind === "set-iterator-cursor"
		) {
			const cursor = coreSpecializationRecipePayloadAt(
				recipeTable,
				row,
				kind,
				"iteratorCursor",
			);
			const initialize = requireInstruction(cursor.initialize);
			const steps = cursor.steps.map(requireInstruction);
			if (
				initialize.type !== "getIterator" ||
				steps.length === 0 ||
				steps.some((step) => step.type !== "iteratorStep")
			) {
				throw new Error(`Core iterator plan ${id} lost its protocol steps`);
			}
			const iteratorSteps = steps.filter(
				(step): step is Extract<CompilerInstruction, { type: "iteratorStep" }> =>
					step.type === "iteratorStep",
			);
			const common = {
				...envelope(row),
				anchors: [initialize, iteratorSteps[0]!] as const,
				license: {
					guard: "structural" as const,
					genericTwin: "retained" as const,
					materialization: "none" as const,
					admission: admission(row),
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
			switch (kind) {
				case "array-values-iterator-cursor":
					regions.push({
						...common,
						kind: kind,
						representation: "array-values-authoritative-cursor",
						protocol: "array-values",
					});
					break;
				case "string-iterator-cursor":
					regions.push({
						...common,
						kind: kind,
						representation: "string-authoritative-cursor",
						protocol: "string",
					});
					break;
				case "typed-array-iterator-cursor":
					regions.push({
						...common,
						kind: kind,
						representation: "typed-array-authoritative-cursor",
						protocol: "typed-array-values",
					});
					break;
				case "map-iterator-cursor":
					regions.push({
						...common,
						kind: kind,
						representation: "map-authoritative-cursor",
						protocol: "map",
					});
					break;
				case "set-iterator-cursor":
					regions.push({
						...common,
						kind: kind,
						representation: "set-authoritative-cursor",
						protocol: "set",
					});
					break;
			}
			continue;
		}
		if (kind === "iterator-result-virtualization") {
			const virtualization = coreSpecializationRecipePayloadAt(
				recipeTable,
				row,
				"iterator-result-virtualization",
				"iteratorResultVirtualization",
			);
			const steps = virtualization.steps.map(requireInstruction);
			if (steps.length === 0 || steps.some((step) => step.type !== "iteratorStep")) {
				throw new Error(`Core iterator-result plan ${id} lost its steps`);
			}
			const iteratorSteps = steps.filter(
				(step): step is Extract<CompilerInstruction, { type: "iteratorStep" }> =>
					step.type === "iteratorStep",
			);
			regions.push({
				...envelope(row),
				anchors: [iteratorSteps[0]!] as const,
				kind: "iterator-result-virtualization",
				license: {
					guard: virtualization.guard,
					genericTwin: "retained",
					materialization: "on-demand",
					admission: admission(row),
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
		if (kind === "iterator-entry-pair-virtualization") {
			const entry = coreSpecializationRecipePayloadAt(
				recipeTable,
				row,
				"iterator-entry-pair-virtualization",
				"iteratorEntryPairVirtualization",
			);
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
				throw new Error(`Core iterator-entry plan ${id} lost its protocol`);
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
				throw new Error(`Core iterator-entry plan ${id} lost its pair steps`);
			}
			regions.push({
				...envelope(row),
				anchors: [outerStep, innerInitialize] as const,
				kind: "iterator-entry-pair-virtualization",
				license: {
					guard: entry.guard,
					genericTwin: "retained",
					materialization: "on-demand",
					admission: admission(row),
				},
				representation: "virtual-iterator-entry-pair",
				composition: "overlay",
				cost: { score: 32, metadataOperations: claims.length },
				cursorInitialize,
				outerStep,
				innerInitialize,
				innerSteps: [loweredInnerSteps[0]!, loweredInnerSteps[1]!],
				innerCloses: loweredInnerCloses,
				runtimeGuard: "exact-entry-pair-cursor",
				correspondence: "entry-pair-elements",
				stateSynchronization: "authoritative-language-object",
				fallback: "materialize-entry-pair-then-iterate",
			});
			continue;
		}
		if (kind === "string-split-cursor") {
			const cursor = coreSpecializationRecipePayloadAt(
				recipeTable,
				row,
				"string-split-cursor",
				"stringSplitCursor",
			);
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
				(call.type !== "call" && call.type !== "callKnown") ||
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
				throw new Error(`Core String.split cursor ${id} lost its trace`);
			}
			regions.push({
				...envelope(row),
				anchors: [call, branch, length, backedge],
				kind: "string-split-cursor",
				license: {
					guard: cursor.guard,
					genericTwin: "retained",
					materialization: "on-demand",
					admission: admission(row),
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
		if (kind === "string-split-projection") {
			const split = coreSpecializationRecipePayloadAt(
				recipeTable,
				row,
				"string-split-projection",
				"stringSplitProjection",
			);
			const call = requireInstruction(split.call);
			const property =
				split.property === undefined ? undefined : requireInstruction(split.property);
			const separator = requireInstruction(split.separator);
			if (
				(call.type !== "call" && call.type !== "callKnown") ||
				(property !== undefined && property.type !== "loadPropertyStatic") ||
				separator.type !== "createString"
			) {
				throw new Error(`Core String.split plan ${id} lost its producers`);
			}
			const loads = split.loads.map((load) => {
				const instruction = requireInstruction(load.instruction);
				if (load.kind === "length") {
					if (instruction.type !== "loadPropertyStatic") {
						throw new Error(`Core String.split plan ${id} lost a length load`);
					}
					return { instruction, kind: "length" as const };
				}
				const key = requireInstruction(load.key);
				if (instruction.type !== "loadProperty" || key.type !== "createNumber") {
					throw new Error(`Core String.split plan ${id} lost an element load`);
				}
				return {
					instruction,
					kind: "element" as const,
					index: load.index,
					key,
				};
			});
			regions.push({
				...envelope(row),
				anchors: [call, loads[0]!.instruction],
				kind: "string-split-projection",
				license: {
					guard: split.guard,
					genericTwin: "retained",
					materialization: "whole-region",
					admission: admission(row),
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
		if (kind === "regexp-exec-projection") {
			const regexp = coreSpecializationRecipePayloadAt(
				recipeTable,
				row,
				"regexp-exec-projection",
				"regexpExecProjection",
			);
			const call = requireInstruction(regexp.call);
			const property =
				regexp.property === undefined ? undefined : requireInstruction(regexp.property);
			if (
				(call.type !== "call" && call.type !== "callKnown") ||
				(property !== undefined && property.type !== "loadPropertyStatic")
			) {
				throw new Error(`Core RegExp.exec plan ${id} lost its call`);
			}
			const nullChecks = regexp.nullChecks.map((check) => {
				const comparison = requireInstruction(check.comparison);
				const nullValue = requireInstruction(check.nullValue);
				if (comparison.type !== "binary" || nullValue.type !== "createNull") {
					throw new Error(`Core RegExp.exec plan ${id} lost a null check`);
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
								(constructorIntrinsic.type !== "loadIntrinsic" &&
									constructorIntrinsic.type !== "loadPrimordial") ||
								(construct.type !== "construct" && construct.type !== "callKnown")
							) {
								throw new Error(`Core RegExp.exec plan ${id} lost its literal`);
							}
							return { constructorIntrinsic, construct };
						})();
			const loads = regexp.loads.map((load) => {
				const instruction = requireInstruction(load.instruction);
				const key = requireInstruction(load.key);
				if (instruction.type !== "loadProperty" || key.type !== "createNumber") {
					throw new Error(`Core RegExp.exec plan ${id} lost a capture`);
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
						throw new Error(`Core RegExp.exec plan ${id} lost a length`);
					}
					return {
						instruction,
						key,
						captureIndex: load.captureIndex,
						consumer: { kind: "length" as const, property: consumerProperty },
					};
				}
				if (consumer.kind === "number") {
					const intrinsic =
						consumer.intrinsic === undefined
							? undefined
							: requireInstruction(consumer.intrinsic);
					const consumerCall = requireInstruction(consumer.call);
					if (
						(intrinsic !== undefined && intrinsic.type !== "loadIntrinsic") ||
						(consumerCall.type !== "call" && consumerCall.type !== "callKnown")
					) {
						throw new Error(`Core RegExp.exec plan ${id} lost Number`);
					}
					return {
						instruction,
						key,
						captureIndex: load.captureIndex,
						consumer: {
							kind: "number" as const,
							intrinsic,
							call: consumerCall,
						},
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
						throw new Error(`Core RegExp.exec plan ${id} lost charCodeAt`);
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
						throw new Error(`Core RegExp.exec plan ${id} lost a move`);
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
					throw new Error(`Core RegExp.exec plan ${id} lost ASCII case`);
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
				...envelope(row),
				anchors: [call, loads[0]!.instruction],
				kind: "regexp-exec-projection",
				license: {
					guard: regexp.guard,
					genericTwin: "retained",
					materialization: "whole-region",
					admission: admission(row),
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
		if (kind === "regexp-iterator-projection") {
			const regexp = coreSpecializationRecipePayloadAt(
				recipeTable,
				row,
				"regexp-iterator-projection",
				"regexpIteratorProjection",
			);
			const step = requireInstruction(regexp.step);
			const doneBranch = requireInstruction(regexp.doneBranch);
			if (step.type !== "iteratorStep" || doneBranch.type !== "jumpIf") {
				throw new Error(`Core RegExp iterator plan ${id} lost its step`);
			}
			const loads = regexp.loads.map((load) => {
				const instruction = requireInstruction(load.instruction);
				const key = requireInstruction(load.key);
				const numberIntrinsic =
					load.numberIntrinsic === undefined
						? undefined
						: requireInstruction(load.numberIntrinsic);
				const numberCall = requireInstruction(load.numberCall);
				if (
					instruction.type !== "loadProperty" ||
					key.type !== "createNumber" ||
					(numberIntrinsic !== undefined && numberIntrinsic.type !== "loadIntrinsic") ||
					(numberCall.type !== "call" && numberCall.type !== "callKnown")
				) {
					throw new Error(`Core RegExp iterator plan ${id} lost a capture`);
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
				...envelope(row),
				anchors: [step, doneBranch, loads[0]!.instruction],
				kind: "regexp-iterator-projection",
				license: {
					guard: regexp.guard,
					genericTwin: "retained",
					materialization: "on-demand",
					admission: admission(row),
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
		if (kind === "string-slice-number") {
			const slice = coreSpecializationRecipePayloadAt(
				recipeTable,
				row,
				"string-slice-number",
				"stringSliceNumber",
			);
			const property =
				slice.property === undefined ? undefined : requireInstruction(slice.property);
			const sliceCall = requireInstruction(slice.sliceCall);
			const start = requireInstruction(slice.sliceStartInstruction);
			const numberIntrinsic =
				slice.numberIntrinsic === undefined
					? undefined
					: requireInstruction(slice.numberIntrinsic);
			const numberCall = requireInstruction(slice.numberCall);
			if (
				(property !== undefined && property.type !== "loadPropertyStatic") ||
				(sliceCall.type !== "call" && sliceCall.type !== "callKnown") ||
				(start.type !== "createNumber" && start.type !== "createF64") ||
				(numberIntrinsic !== undefined && numberIntrinsic.type !== "loadIntrinsic") ||
				(numberCall.type !== "call" && numberCall.type !== "callKnown")
			) {
				throw new Error(`Core String.slice plan ${id} lost its producers`);
			}
			regions.push({
				...envelope(row),
				anchors: [sliceCall, numberCall],
				kind: "string-slice-number",
				license: {
					guard: slice.guard,
					genericTwin: "retained",
					materialization: "none",
					admission: admission(row),
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
		if (kind === "string-char-code-at-chain") {
			const chain = coreSpecializationRecipePayloadAt(
				recipeTable,
				row,
				"string-char-code-at-chain",
				"stringCharCodeAt",
			);
			const property = requireInstruction(chain.property);
			const call = requireInstruction(chain.call);
			if (property.type !== "loadPropertyStatic" || call.type !== "call") {
				throw new Error(`Core String.charCodeAt plan ${id} lost its call`);
			}
			regions.push({
				...envelope(row),
				anchors: [property, call],
				kind: "string-char-code-at-chain",
				license: {
					guard: chain.guard,
					genericTwin: "retained",
					materialization: "none",
					admission: admission(row),
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
		if (kind === "builtin-collection-call-chain") {
			const chain = coreSpecializationRecipePayloadAt(
				recipeTable,
				row,
				"builtin-collection-call-chain",
				"builtinCollectionCall",
			);
			const property = requireInstruction(chain.property);
			const call = requireInstruction(chain.call);
			if (property.type !== "loadPropertyStatic" || call.type !== "call") {
				throw new Error(`Core collection plan ${id} lost its call`);
			}
			regions.push({
				...envelope(row),
				anchors: [property, call],
				kind: "builtin-collection-call-chain",
				license: {
					guard: chain.guard,
					genericTwin: "retained",
					materialization: "none",
					admission: admission(row),
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
		if (kind === "stack-object-plan") {
			const stack = coreSpecializationRecipePayloadAt(
				recipeTable,
				row,
				"stack-object-plan",
				"stackObject",
			);
			const allocation = requireInstruction(stack.allocation);
			if (
				allocation.type !== "createObject" &&
				allocation.type !== "createObjectShaped"
			) {
				throw new Error(`Core stack-object plan ${id} has no allocation`);
			}
			const accesses = stack.accesses.map(({ instruction, slot }) => {
				const lowered = requireInstruction(instruction);
				if (
					lowered.type !== "loadProperty" &&
					lowered.type !== "loadPropertyStatic" &&
					lowered.type !== "storeProperty" &&
					lowered.type !== "storePropertyStatic"
				) {
					throw new Error(`Core stack-object plan ${id} has an invalid access`);
				}
				return { instruction: lowered, slot };
			});
			const materializations = stack.materializations.map(({ instruction }) => {
				const lowered = requireInstruction(instruction);
				if (lowered.type !== "return") {
					throw new Error(`Core stack-object plan ${id} has an invalid materialization`);
				}
				return { instruction: lowered, kind: "return" as const };
			});
			const materializes = materializations.length > 0;
			regions.push({
				...envelope(row),
				anchors: [allocation],
				kind: "stack-object-plan",
				license: {
					guard: {
						dependencies: [],
						obligations: [
							{
								kind: "fallback",
								id: `${id}:fallback`,
								cause: "escape",
							},
							...materializations.map((_, index) => ({
								kind: "materialize" as const,
								id: `${id}:materialize:${index}`,
								cause: "escape" as const,
							})),
						],
					},
					genericTwin: "retained",
					materialization: materializes ? "on-demand" : "none",
					admission: admission(row),
				},
				representation: "activation-local-fixed-shape-objects",
				cost: {
					score: Math.max(1, stack.slotCount),
					metadataOperations: claims.length,
				},
				sites: [
					{
						allocation,
						mode: stack.mode,
						slotCount: stack.slotCount,
						accesses,
						materializations,
					},
				],
			});
			continue;
		}
		if (kind === "dense-array-plan") continue;
		throw new Error("Core target encountered an unsupported specialization plan");
	}
	return regions;
}

interface CoreFieldCall {
	readonly allocation: CoreInstructionId;
	readonly call: CoreInstructionId;
	readonly entries: Array<{ readonly functionIndex: number; readonly entryId: number }>;
}

function lowerFunctionToTarget(
	coreFunction: CoreFunctionStore,
	executionFunction: number,
	functionMap: CoreTargetFunctionMap,
	directEntryIds: ReadonlyMap<CoreInstructionId, number>,
	numericSortCallbacks: ReadonlyMap<CoreInstructionId, CompilerNumericSortCallback>,
	directEntryTargets: ReadonlyMap<
		CoreInstructionId,
		{ target: CoreFunctionId; guarded: boolean }
	>,
	directEntryPlans: ReadonlyArray<CoreDirectEntryPlan>,
	directBuiltinCallbacks: ReadonlyMap<CoreInstructionId, CoreFunctionId>,
	fieldCallPlans: ReadonlyArray<CoreFieldCall>,
	unsignedArithmetic: ReadonlySet<CoreInstructionId>,
	privateNumericArrayElements: ReadonlySet<CoreInstructionId>,
	privatePackedRestArrayElements: ReadonlyArray<CorePrivatePackedRestArrayElementPlan>,
	operatorInputs: ReadonlyMap<CoreInstructionId, CompilerOperatorInputKindMasks>,
	builtinInputs: ReadonlyMap<CoreInstructionId, ReadonlyArray<number>>,
	recipeTable: CoreSpecializationRecipeTable,
	recipeRows: ReadonlyArray<number>,
	blockOrder: ReadonlyArray<CoreBlockId>,
	siteFacts: ReadonlyMap<string, CompilerSiteFacts>,
	instructionSites: WeakMap<object, CompilerSiteFacts>,
	assignStorage: CoreStorageAssigner,
	loopBackedgeInstructions: typeof executionLoopBackedgeInstructions,
	layoutBlocks: LowerCoreToCoreTargetOptions["layoutBlocks"],
	createParallelCopyLowerer: LowerCoreToCoreTargetOptions["createParallelCopyLowerer"],
	preserveResumableRepresentations: boolean,
): CoreTargetFunction {
	const privatePackedRestElements = new Map(
		privatePackedRestArrayElements.map((plan) => [plan.instruction, plan]),
	);
	const privatePackedRestAllocations = new Map(
		privatePackedRestArrayElements.map((plan) => [plan.allocation, plan]),
	);
	const privatePackedRestLengths = new Map(
		privatePackedRestArrayElements.flatMap((plan) =>
			plan.lengthLoads.map((instruction) => [instruction, plan] as const),
		),
	);
	const protectedInstructions = new Set(
		recipeRows.flatMap((row) => coreSpecializationRecipeClaimsAt(recipeTable, row)),
	);
	const omittedInstructions = immediateOnlyInstructions(
		coreFunction,
		protectedInstructions,
	);
	const loweredBlockForCore = new Map<CoreBlockId, number>(
		blockOrder.map((block, index) => [block, index]),
	);
	let blocks: Array<{
		instructions: Array<CompilerInstruction>;
		sourcePosition?: number;
	}> = blockOrder.map(() => ({ instructions: [] }));
	const literalSwitches: Array<
		NonNullable<CoreTargetFunction["literalSwitches"]>[number]
	> = [];
	const loweredInstructions = new Map<CoreInstructionId, CompilerInstruction>();
	const guardedTargets = new Map<CoreInstructionId, ReadonlyArray<CoreFunctionId>>();
	const exactCallTargets = new Set<CoreInstructionId>();
	for (const row of recipeRows) {
		if (coreSpecializationRecipeKindAt(recipeTable, row) !== "guarded-direct-call")
			continue;
		guardedTargets.set(
			coreSpecializationRecipeAnchorsAt(recipeTable, row)[0]!,
			coreSpecializationRecipeTargetFunctionsAt(recipeTable, row),
		);
		if (coreSpecializationRecipeRepresentationAt(recipeTable, row) === "exact-function") {
			exactCallTargets.add(coreSpecializationRecipeAnchorsAt(recipeTable, row)[0]!);
		}
	}
	for (const [instruction, { target, guarded }] of directEntryTargets) {
		guardedTargets.set(instruction, [target]);
		if (!guarded) exactCallTargets.add(instruction);
	}
	for (const site of fieldCallPlans) {
		guardedTargets.set(site.call, [
			...new Set([
				...(guardedTargets.get(site.call) ?? []),
				...site.entries.map((entry) => functionMap.executionToCore[entry.functionIndex]!),
			]),
		]);
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
	for (const row of recipeRows) {
		const kind = coreSpecializationRecipeKindAt(recipeTable, row);
		if (kind === "dense-array-plan") {
			const denseArray = coreSpecializationRecipePayloadAt(
				recipeTable,
				row,
				"dense-array-plan",
				"denseArray",
			);
			denseReserveLengths.set(denseArray.allocation, denseArray.length);
		}
		if (kind === "string-split-projection") {
			const split = coreSpecializationRecipePayloadAt(
				recipeTable,
				row,
				"string-split-projection",
				"stringSplitProjection",
			);
			plannedBuiltinCalls.set(
				split.call,
				split.builtinCall as unknown as CoreAttributeValue,
			);
		}
		if (kind === "string-split-cursor") {
			const cursor = coreSpecializationRecipePayloadAt(
				recipeTable,
				row,
				"string-split-cursor",
				"stringSplitCursor",
			);
			plannedBuiltinCalls.set(
				cursor.call,
				cursor.splitBuiltinCall as unknown as CoreAttributeValue,
			);
			plannedBuiltinCalls.set(
				cursor.trimCall,
				cursor.trimBuiltinCall as unknown as CoreAttributeValue,
			);
			for (const length of cursor.primitiveStringLengths) {
				plannedPrimitiveStringLengths.set(length, true);
			}
		}
		if (kind === "string-slice-number") {
			const slice = coreSpecializationRecipePayloadAt(
				recipeTable,
				row,
				"string-slice-number",
				"stringSliceNumber",
			);
			plannedBuiltinCalls.set(
				slice.sliceCall,
				slice.builtinCall as unknown as CoreAttributeValue,
			);
		}
		if (kind === "regexp-exec-projection") {
			const regexp = coreSpecializationRecipePayloadAt(
				recipeTable,
				row,
				"regexp-exec-projection",
				"regexpExecProjection",
			);
			plannedBuiltinCalls.set(
				regexp.call,
				regexp.builtinCall as unknown as CoreAttributeValue,
			);
		}
		if (kind === "string-char-code-at-chain") {
			const chain = coreSpecializationRecipePayloadAt(
				recipeTable,
				row,
				"string-char-code-at-chain",
				"stringCharCodeAt",
			);
			plannedBuiltinCalls.set(
				chain.call,
				chain.builtinCall as unknown as CoreAttributeValue,
			);
			if (chain.bounded !== undefined) {
				plannedDirectStringCharCodeAtPositions.set(chain.call, "inBounds");
				plannedPrimitiveStringLengths.set(chain.bounded.length, true);
			}
		}
		if (kind === "builtin-collection-call-chain") {
			const chain = coreSpecializationRecipePayloadAt(
				recipeTable,
				row,
				"builtin-collection-call-chain",
				"builtinCollectionCall",
			);
			plannedBuiltinCalls.set(
				chain.call,
				chain.builtinCall as unknown as CoreAttributeValue,
			);
			if (chain.exactReceiver !== undefined) {
				plannedExactCollectionReceivers.set(chain.call, chain.exactReceiver);
			}
		}
		if (kind === "fresh-array-length") {
			const fresh = coreSpecializationRecipePayloadAt(
				recipeTable,
				row,
				"fresh-array-length",
				"freshArrayLength",
			);
			plannedExactArrayLengths.set(fresh.load, true);
		}
		if (kind === "function-call-chain") {
			const call = coreSpecializationRecipePayloadAt(
				recipeTable,
				row,
				"function-call-chain",
				"functionCall",
			);
			plannedDirectFunctionCalls.set(call.call, true);
			if (call.targetFunction !== undefined) {
				plannedDirectCallTargets.set(call.call, call.targetFunction);
			}
		}
	}

	const reservedAbiColors = new Set<number>();
	if (directEntryPlans.length > 0 || coreSupportsDirectEntries(coreFunction)) {
		for (let index = 0; index < coreFunction.parameterCount; index++) {
			reservedAbiColors.add(index);
		}
	}
	const allocation = assignStorage(
		coreFunction,
		blockOrder,
		reservedAbiColors,
		directEntryPlans.flatMap((entry) =>
			entry.valueRepresentations === undefined ? [] : [entry.valueRepresentations],
		),
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

	const selectedInBoundsPackedRestElements = new Set<CoreInstructionId>();
	for (const row of recipeRows) {
		if (coreSpecializationRecipeKindAt(recipeTable, row) !== "indexed-length-loop")
			continue;
		const indexed = coreSpecializationRecipePayloadAt(
			recipeTable,
			row,
			"indexed-length-loop",
			"indexedLengthLoop",
		);
		for (const element of indexed.elements) {
			if (
				element.kind === "load" &&
				element.arrayIndexIsUint32 &&
				privatePackedRestElements.has(element.instruction)
			)
				selectedInBoundsPackedRestElements.add(element.instruction);
		}
	}
	const canonicalRegisterRepresentations = new Map(
		Array.from(
			{ length: allocatedRegisterCount },
			(_, register) =>
				[
					register,
					(coreFunction.isGenerator || coreFunction.isAsync) &&
					!preserveResumableRepresentations
						? ("boxed" as const)
						: physicalRegisterClass(registerRepresentations.get(register)!),
				] as const,
		),
	);
	const entryRegisterRepresentations = directEntryPlans.map((entry) => {
		const overriddenCalls = new Set(entry.callOverrides?.map((call) => call.instruction));
		const representations = new Map(canonicalRegisterRepresentations);
		if (entry.valueRepresentations !== undefined) {
			const assigned = new Map<number, CoreTargetRegisterRepresentation>();
			for (const [value, register] of allocation.registers) {
				let representation = planCoreTargetRepresentation(
					entry.valueRepresentations[value]!,
				);
				if (coreFunction.kernel.valueDefinitionKind(value) === 1) {
					const instruction = coreInstructionId(
						coreFunction.kernel.valueDefinitionOwner(value),
					);
					const opcode = coreFunction.instructionOpcodeName(instruction);
					const directRestOperation =
						(opcode === "loadProperty" &&
							selectedInBoundsPackedRestElements.has(instruction)) ||
						(opcode === "loadPropertyStatic" &&
							privatePackedRestLengths.has(instruction));
					if (
						!directRestOperation &&
						!overriddenCalls.has(instruction) &&
						![
							"binary",
							"unary",
							"move",
							"createNumber",
							"createBoolean",
							"createString",
							...(entry.fieldParameters === undefined
								? []
								: ["loadPropertyStatic", "call"]),
							...(entry.argumentRepresentations === undefined
								? []
								: ["loadArgumentCount", "loadArgument", "loadStaticArgument"]),
						].includes(opcode)
					)
						representation = representations.get(register)!;
				}
				const previous = assigned.get(register);
				assigned.set(
					register,
					previous === undefined || previous === representation
						? representation
						: "boxed",
				);
			}
			for (const [register, representation] of assigned) {
				if (representations.get(register) === "boxed")
					representations.set(register, representation);
			}
		}
		return representations;
	});
	const copyLowerer = createParallelCopyLowerer?.(
		nextRegister,
		registerRepresentations,
		canonicalRegisterRepresentations,
		entryRegisterRepresentations,
	);

	const parallelCopies: Array<CoreTargetParallelCopy> = [];
	const temporaryRegisters: Array<number> = [];
	const kernel = coreFunction.kernel;
	const edgeBlock = (
		target: CoreBlockId,
		argumentStart: number,
		argumentCount: number,
		sourcePosition: number | undefined,
	): number => {
		const targetBlock = loweredBlockForCore.get(target);
		if (targetBlock === undefined) {
			throw new Error(`Core edge targets unreachable block b${target}`);
		}
		const parameterStart = kernel.blockParameterStart(target);
		const parameterCount = kernel.blockParameterCount(target);
		if (parameterCount > 0 && kernel.blockParameterRole(parameterStart) === 1) {
			throw new Error(`Ordinary Core edge targets exception block b${target}`);
		}
		if (argumentCount !== parameterCount) {
			throw new Error(
				`Core edge b${target} expects ${parameterCount} arguments, received ${argumentCount}`,
			);
		}
		const assignments = new Array<{ destination: number; source: number }>(
			parameterCount,
		);
		for (let index = 0; index < parameterCount; index++) {
			assignments[index] = {
				destination: registerForValue(kernel.blockParameterValue(parameterStart + index)),
				source: registerForValue(kernel.operandAt(argumentStart + index)),
			};
		}
		const copy =
			copyLowerer?.lower(assignments) ??
			parallelMoves(assignments, nextRegister, registerRepresentations);
		if (copy.moves.length === 0) return targetBlock;
		parallelCopies.push({ kind: "edge", assignments, ...copy });
		temporaryRegisters.push(...copy.temporaries);
		const block = blocks.length;
		blocks.push({
			instructions: [...copy.moves, { type: "jump", blocks: [targetBlock] }],
			...(layoutBlocks === undefined || sourcePosition === undefined
				? {}
				: { sourcePosition }),
		});
		return block;
	};
	const lowerTerminatorEdge = (
		edge: number,
		sourcePosition: number | undefined,
	): number =>
		edgeBlock(
			kernel.terminatorEdgeBlock(edge),
			kernel.terminatorEdgeArgumentStart(edge),
			kernel.terminatorEdgeArgumentCount(edge),
			sourcePosition,
		);

	const pendingOperationSafepoints: Array<
		Omit<
			Extract<CoreTargetSafepoint, { kind: "operation" }>,
			keyof CoreTargetSafepointRoots
		>
	> = [];
	let edgeSourcePosition = -1;
	for (const blockId of blockOrder) {
		const loweredBlock = loweredBlockForCore.get(blockId)!;
		const instructions = blocks[loweredBlock]!.instructions;
		const handler = kernel.blockHandlerBlock(blockId);
		if (handler !== undefined) {
			const targetBlock = loweredBlockForCore.get(handler);
			if (targetBlock === undefined) {
				throw new Error(`Core handler targets unreachable block b${handler}`);
			}
			const parameterStart = kernel.blockParameterStart(handler);
			const parameterCount = kernel.blockParameterCount(handler);
			if (parameterCount === 0 || kernel.blockParameterRole(parameterStart) !== 1) {
				throw new Error(`Core handler b${handler} has no exception parameter`);
			}
			instructions.push({
				type: "tryBegin",
				blocks: [targetBlock, loweredBlock],
			});
			const argumentStart = kernel.blockHandlerArgumentStart(blockId);
			const argumentCount = kernel.blockHandlerArgumentCount(blockId);
			if (argumentCount !== parameterCount - 1) {
				throw new Error(
					`Core handler b${handler} expects ${parameterCount - 1} explicit arguments, received ${argumentCount}`,
				);
			}
			const assignments = new Array<{ destination: number; source: number }>(
				argumentCount,
			);
			for (let index = 0; index < argumentCount; index++) {
				assignments[index] = {
					destination: registerForValue(
						kernel.blockParameterValue(parameterStart + index + 1),
					),
					source: registerForValue(kernel.handlerArgumentAt(argumentStart + index)),
				};
			}
			const copy =
				copyLowerer?.lower(assignments) ??
				parallelMoves(assignments, nextRegister, registerRepresentations);
			if (copy.moves.length > 0) {
				parallelCopies.push({ kind: "handler-input", assignments, ...copy });
				temporaryRegisters.push(...copy.temporaries);
			}
			instructions.push(...copy.moves);
		}
		const blockParameterStart = kernel.blockParameterStart(blockId);
		const blockParameterCount = kernel.blockParameterCount(blockId);
		if (blockParameterCount > 0 && kernel.blockParameterRole(blockParameterStart) === 1) {
			instructions.push({
				type: "catch",
				registers: [registerForValue(kernel.blockParameterValue(blockParameterStart))],
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
				exactCallTargets.has(instruction),
				plannedBuiltinCalls.get(instruction),
				plannedExactCollectionReceivers.get(instruction),
				plannedExactArrayLengths.get(instruction),
				plannedDirectStringCharCodeAtPositions.get(instruction),
				plannedPrimitiveStringLengths.get(instruction),
				plannedDirectFunctionCalls.get(instruction),
				plannedDirectCallTargets.get(instruction),
				!protectedInstructions.has(instruction),
			);
			const numericCallback = numericSortCallbacks.get(instruction);
			if (numericCallback !== undefined && rebuilt.type === "call")
				rebuilt.numericSortCallback = numericCallback;
			const directCallback = directBuiltinCallbacks.get(instruction);
			if (directCallback !== undefined && rebuilt.type === "call") {
				rebuilt.directCallbackFunctionIndex =
					functionMap.coreToExecution[directCallback]!;
			}
			const reserveLength = denseReserveLengths.get(instruction);
			if (reserveLength !== undefined && rebuilt.type !== "createArray") {
				throw new Error(`Core dense-array plan lost allocation @${instruction}`);
			}
			let lowered: CompilerInstruction = rebuilt;
			if (reserveLength !== undefined && rebuilt.type === "createArray") {
				lowered = { ...rebuilt, freshDenseReserveLength: reserveLength };
			}
			if (unsignedArithmetic.has(instruction)) {
				if (lowered.type !== "binary")
					throw new Error("Unsigned arithmetic lost its operation");
				lowered = { ...lowered, unsignedArithmetic: true };
			}
			if (privateNumericArrayElements.has(instruction)) {
				if (lowered.type !== "loadProperty")
					throw new Error("Private numeric array proof lost its load");
				lowered = { ...lowered, exactContainedArrayElement: true };
			}
			const privatePackedRestElement = privatePackedRestElements.get(instruction);
			if (privatePackedRestElement !== undefined) {
				if (lowered.type !== "loadProperty")
					throw new Error("Private packed rest array proof lost its load");
				lowered = {
					...lowered,
					exactPackedRestArrayElement: true,
					packedRestStartIndex: privatePackedRestElement.startIndex,
				};
			}
			const privatePackedRestLength = privatePackedRestLengths.get(instruction);
			if (privatePackedRestLength !== undefined) {
				if (lowered.type !== "loadPropertyStatic")
					throw new Error("Private packed rest array proof lost its length");
				lowered = {
					...lowered,
					packedRestStartIndex: privatePackedRestLength.startIndex,
				};
			}
			if (privatePackedRestAllocations.has(instruction)) {
				if (lowered.type !== "createRestArguments")
					throw new Error("Private packed rest array proof lost its allocation");
				lowered = { ...lowered, virtualPackedRest: true };
			}
			const builtinMasks = builtinInputs.get(instruction);
			if (builtinMasks !== undefined) {
				if (
					lowered.type !== "callKnown" ||
					lowered.registers.length !== builtinMasks.length + 1
				)
					throw new Error("Builtin input proof lost its operands");
				lowered = { ...lowered, exactInputKindMasks: builtinMasks };
			}
			const inputMasks = operatorInputs.get(instruction);
			if (lowered.type === "binary" && inputMasks?.length === 2)
				lowered = { ...lowered, exactInputKindMasks: inputMasks };
			if (lowered.type === "unary" && inputMasks?.length === 1)
				lowered = { ...lowered, exactInputKindMasks: inputMasks };
			loweredInstructions.set(instruction, lowered);
			if (siteFacts.size > 0) {
				const site = siteFacts.get(
					coreCompilerSiteId(
						coreFunction.id,
						blockId,
						instruction,
						coreFunction.instructionOpcodeName(instruction),
					),
				);
				if (site !== undefined) instructionSites.set(lowered, site);
			}
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
					instructions.push({
						type: "move",
						registers: [constrained, operand],
					});
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
			const operandStart = kernel.instructionOperandStart(instruction);
			const operandCount = kernel.instructionOperandCount(instruction);
			const resultCount = kernel.instructionResultCount(instruction);
			for (let index = 0; index < operandCount; index++) {
				if (immediateValues?.[resultCount + index] === undefined) continue;
				const input = kernel.operandAt(operandStart + index);
				if (kernel.valueDefinitionKind(input) !== 1) continue;
				const origin = kernel.valueDefinitionOwner(input) as CoreInstructionId;
				if (
					omittedInstructions.has(origin) &&
					coreInstructionNeedsOperationSafepoint(coreFunction, origin)
				) {
					realizedCoreInstructions.add(origin);
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
		const terminatorKind = coreFunction.instructionKind(terminatorId);
		const terminatorOperandStart = kernel.instructionOperandStart(terminatorId);
		const terminatorEdgeStart = kernel.terminatorEdgeStart(terminatorId);
		const terminatorEdgeCount = kernel.terminatorEdgeCount(terminatorId);
		const terminatorPosition = coreFunction.instructionSourcePosition(terminatorId);
		edgeSourcePosition =
			terminatorPosition ??
			instructions.findLast((instruction) => instruction.type === "sourcePos")?.pos ??
			edgeSourcePosition;
		instructions.push(...sourcePositionMarker(terminatorPosition));
		switch (terminatorKind) {
			case "jump": {
				const lowered: Extract<CompilerInstruction, { type: "jump" }> = {
					type: "jump",
					blocks: [lowerTerminatorEdge(terminatorEdgeStart, edgeSourcePosition)],
				};
				instructions.push(lowered);
				loweredInstructions.set(terminatorId, lowered);
				break;
			}
			case "branch": {
				const lowered: Extract<CompilerInstruction, { type: "jumpIf" }> = {
					type: "jumpIf",
					registers: [registerForValue(kernel.operandAt(terminatorOperandStart))],
					blocks: [lowerTerminatorEdge(terminatorEdgeStart, edgeSourcePosition)],
				};
				instructions.push(lowered, {
					type: "jump",
					blocks: [lowerTerminatorEdge(terminatorEdgeStart + 1, edgeSourcePosition)],
				});
				loweredInstructions.set(terminatorId, lowered);
				break;
			}
			case "guard":
				instructions.push(
					{
						type: "jumpIf",
						registers: [registerForValue(kernel.operandAt(terminatorOperandStart))],
						blocks: [lowerTerminatorEdge(terminatorEdgeStart, edgeSourcePosition)],
					},
					{
						type: "jump",
						blocks: [lowerTerminatorEdge(terminatorEdgeStart + 1, edgeSourcePosition)],
					},
				);
				break;
			case "return":
			case "throw": {
				const lowered: Extract<CompilerInstruction, { type: "return" | "throw" }> = {
					type: terminatorKind,
					registers: [registerForValue(kernel.operandAt(terminatorOperandStart))],
				};
				instructions.push(lowered);
				loweredInstructions.set(terminatorId, lowered);
				break;
			}
			case "switch": {
				const start = instructions.length;
				const immediates = new Map<CoreRepresentation, number>();
				let matches: number | undefined;
				const cases: Array<{ value: number; block: number }> = [];
				const stringCases: Array<{ stringIndex: number; block: number }> = [];
				let numeric = terminatorEdgeCount >= 5;
				let strings =
					terminatorEdgeCount >= 3 &&
					terminatorEdgeCount <= NATIVE_STRING_SWITCH_CASE_LIMIT + 1;
				for (let index = 0; index < terminatorEdgeCount - 1; index++) {
					const edge = terminatorEdgeStart + index;
					const caseValue = kernel.terminatorEdgeCaseValue(edge);
					if (caseValue === undefined) {
						throw new Error(`Core switch in b${blockId} has no case value`);
					}
					const targetBlock = lowerTerminatorEdge(edge, edgeSourcePosition);
					if (strings && caseValue.kind === "string")
						stringCases.push({ stringIndex: caseValue.index, block: targetBlock });
					else strings = false;
					if (
						caseValue.kind !== "number" ||
						!Number.isInteger(caseValue.value) ||
						caseValue.value < -2147483648 ||
						caseValue.value > 2147483647
					)
						numeric = false;
					else
						cases.push({
							value: caseValue.value === 0 ? 0 : caseValue.value,
							block: targetBlock,
						});
					const representation =
						caseValue.kind === "number"
							? "f64"
							: caseValue.kind === "boolean"
								? "boolean"
								: "boxed";
					// Reuse scratch within this dispatch block; Core edges cannot carry it out.
					let immediate = immediates.get(representation);
					if (immediate === undefined) {
						immediate = nextRegister.value++;
						immediates.set(representation, immediate);
						temporaryRegisters.push(immediate);
						registerRepresentations.set(immediate, representation);
					}
					if (matches === undefined) {
						matches = nextRegister.value++;
						temporaryRegisters.push(matches);
						registerRepresentations.set(matches, "boolean");
					}
					instructions.push(
						lowerCoreImmediate(caseValue, immediate),
						{
							type: "binary",
							registers: [
								matches,
								registerForValue(kernel.operandAt(terminatorOperandStart)),
								immediate,
							],
							operator: "===",
						},
						{
							type: "jumpIf",
							registers: [matches],
							blocks: [targetBlock],
						},
					);
				}
				const defaultBlock = lowerTerminatorEdge(
					terminatorEdgeStart + terminatorEdgeCount - 1,
					edgeSourcePosition,
				);
				instructions.push({
					type: "jump",
					blocks: [defaultBlock],
				});
				if (numeric || strings) {
					const site = {
						first: instructions[start]!,
						last: instructions.at(-1)!,
						selector: registerForValue(kernel.operandAt(terminatorOperandStart)),
						defaultBlock,
					};
					literalSwitches.push(
						numeric
							? { ...site, kind: "number", cases }
							: { ...site, kind: "string", cases: stringCases },
					);
				}
				break;
			}
			case "unreachable":
				throw new Error(`Reachable Core block b${blockId} ends in unreachable`);
		}
		if (handler !== undefined) instructions.push({ type: "tryEnd" });
	}
	if (layoutBlocks !== undefined) {
		const order = layoutBlocks(blocks, blockOrder.length);
		if (
			order.length !== blocks.length ||
			order[0] !== 0 ||
			new Set(order).size !== blocks.length ||
			order.some(
				(block) => !Number.isInteger(block) || block < 0 || block >= blocks.length,
			)
		)
			throw new Error(
				"Target block layout must be a permutation retaining entry block zero",
			);
		const relocated = new Map(order.map((block, index) => [block, index]));
		let position = -1;
		for (const block of blocks) {
			block.sourcePosition ??= position;
			position = block.sourcePosition;
			for (const instruction of block.instructions) {
				if (instruction.type === "sourcePos") position = instruction.pos;
				if ("blocks" in instruction)
					for (const [index, target] of instruction.blocks.entries())
						instruction.blocks[index] = relocated.get(target)!;
			}
		}
		for (const [core, block] of loweredBlockForCore)
			loweredBlockForCore.set(core, relocated.get(block)!);
		for (const [index, site] of literalSwitches.entries()) {
			literalSwitches[index] =
				site.kind === "number"
					? {
							...site,
							cases: site.cases.map((label) => ({
								...label,
								block: relocated.get(label.block)!,
							})),
							defaultBlock: relocated.get(site.defaultBlock)!,
						}
					: {
							...site,
							cases: site.cases.map((label) => ({
								...label,
								block: relocated.get(label.block)!,
							})),
							defaultBlock: relocated.get(site.defaultBlock)!,
						};
		}
		blocks = order.map((block) => blocks[block]!);
	}

	const physicalRepresentations = Array.from(
		{ length: nextRegister.value },
		(_, register): CoreTargetRegisterRepresentation => {
			const representation = registerRepresentations.get(register);
			if (representation === undefined) {
				throw new Error(`CoreTarget register r${register} has no representation`);
			}
			return (coreFunction.isGenerator || coreFunction.isAsync) &&
				!preserveResumableRepresentations
				? "boxed"
				: physicalRegisterClass(representation);
		},
	);
	const specializations = lowerCoreSpecializations(
		coreFunction,
		recipeTable,
		recipeRows,
		loweredInstructions,
		loweredBlockForCore,
		registerForValue,
	);
	const fnWithoutGc: Omit<CoreTargetFunction, "gc"> = {
		...(allocation.storageValues === undefined
			? {}
			: {
					storageValues: [
						...allocation.storageValues,
						...Array.from(
							{ length: nextRegister.value - allocatedRegisterCount },
							() => -1,
						),
					],
				}),
		sourcePath: coreFunction.metadata.sourcePath,
		functionIndex: executionFunction,
		nameStringIndex: coreFunction.metadata.nameStringIndex,
		blocks,
		coreBlocks: Object.freeze([...blockOrder]),
		specializations,
		isGenerator: coreFunction.isGenerator,
		isAsync: coreFunction.isAsync,
		parameterCount: coreFunction.parameterCount,
		mappedArgumentSlots: [...coreFunction.metadata.mappedArgumentSlots],
		mappedArguments: coreFunction.metadata.mappedArguments,
		length: coreFunction.metadata.length,
		registerCount: nextRegister.value,
		allocatedRegisterCount,
		registerRepresentations: physicalRepresentations,
		directEntries: [],
		...(literalSwitches.length === 0 ? {} : { literalSwitches }),
		capturedCount: coreFunction.metadata.capturedCount,
		strict: coreFunction.metadata.strict,
		isClassConstructor: coreFunction.metadata.isClassConstructor,
		isDerivedConstructor: coreFunction.metadata.isDerivedConstructor,
		constructorSlotReserve: coreConstructorSlotReserve(coreFunction),
		hasPrototype: coreFunction.metadata.hasPrototype,
		parallelCopies,
		temporaryRegisters: [...new Set(temporaryRegisters)],
	};
	const analysisFunction: CoreTargetFunction = {
		...fnWithoutGc,
		gc: { safepoints: [] },
	};
	const pendingSafepoints = [
		...pendingOperationSafepoints,
		...[...loopBackedgeInstructions(analysisFunction)].map((instruction) => ({
			kind: "loop-backedge" as const,
			instruction,
		})),
	];
	const roots = executionSafepointRoots(
		analysisFunction,
		new Set(pendingSafepoints.map(({ instruction }) => instruction)),
	);
	const instructionOrder = new Map<CompilerInstruction, number>();
	let order = 0;
	for (const block of blocks) {
		for (const instruction of block.instructions)
			instructionOrder.set(instruction, order++);
	}
	const safepoints: Array<CoreTargetSafepoint> = pendingSafepoints
		.map((safepoint) => ({
			...safepoint,
			...roots.get(safepoint.instruction)!,
		}))
		.sort(
			(left, right) =>
				instructionOrder.get(left.instruction)! -
				instructionOrder.get(right.instruction)!,
		);
	const directEntries = directEntryPlans.map((entry, entryIndex) => {
		const representations = [...physicalRepresentations];
		for (const [register, representation] of entryRegisterRepresentations[entryIndex]!)
			representations[register] = representation;
		for (const [temporary, profile] of copyLowerer?.temporaryRepresentations ?? [])
			representations[temporary] = profile[entryIndex]!;
		if (entry.valueRepresentations !== undefined) {
			// A reused boxed source cannot be unboxed by an ordinary edge copy.
			const outgoing = new Map<number, Array<number>>();
			for (const block of blocks)
				for (const instruction of block.instructions) {
					if (
						instruction.type !== "move" ||
						instruction.exactScalarAfterTdz !== undefined
					)
						continue;
					const [destination, source] = instruction.registers;
					const destinations = outgoing.get(source) ?? [];
					destinations.push(destination);
					outgoing.set(source, destinations);
				}
			const pending = [...outgoing.keys()];
			for (let cursor = 0; cursor < pending.length; cursor++) {
				const source = pending[cursor]!;
				for (const destination of outgoing.get(source) ?? []) {
					if (
						representations[destination] === "boxed" ||
						representations[destination] === representations[source] ||
						(representations[source] === "int32" &&
							representations[destination] === "number")
					)
						continue;
					if (physicalRepresentations[destination] !== "boxed") continue;
					representations[destination] = "boxed";
					pending.push(destination);
				}
			}
		}
		return {
			id: entry.id,
			...(entry.callOverrides === undefined
				? {}
				: {
						callOverrides: entry.callOverrides.map(
							({ instruction, target, ...call }) => ({
								...call,
								instruction: loweredInstructions.get(instruction)!,
								functionIndex: functionMap.coreToExecution[target]!,
							}),
						),
					}),
			...(entry.operatorInputs === undefined
				? {}
				: {
						operatorInputs: entry.operatorInputs.map(({ instruction, masks }) => ({
							instruction: loweredInstructions.get(instruction)!,
							masks,
						})),
					}),
			...(entry.fieldParameters === undefined
				? {}
				: {
						fieldParameters: {
							keys: entry.fieldParameters.keys,
							loads: entry.fieldParameters.loads.map(({ instruction, field }) => ({
								instruction: loweredInstructions.get(instruction)!,
								field,
							})),
						},
					}),
			parameterRepresentations: entry.parameterRepresentations.map(
				planCoreTargetRepresentation,
			),
			resultRepresentation: planCoreTargetRepresentation(entry.resultRepresentation),
			...(entry.argumentRepresentations === undefined
				? {}
				: {
						argumentRepresentations: entry.argumentRepresentations.map(
							planCoreTargetRepresentation,
						),
					}),
			...(entry.constantBooleans === undefined
				? {}
				: {
						constantBooleans: entry.constantBooleans.map(({ instruction, value }) => ({
							instruction: loweredInstructions.get(instruction)!,
							value,
						})),
					}),
			registerRepresentations: representations,
			gc: {
				safepoints: safepoints.map((safepoint) => ({
					...safepoint,
					// Entries share the body and only refine boxed registers; liveness is per register.
					rootRegisters: safepoint.rootRegisters.filter(
						(register) =>
							representations[register] === "boxed" ||
							representations[register] === "string",
					),
					incomingRootRegisters: safepoint.incomingRootRegisters.filter(
						(register) =>
							representations[register] === "boxed" ||
							representations[register] === "string",
					),
					outgoingRootRegisters: safepoint.outgoingRootRegisters.filter(
						(register) =>
							representations[register] === "boxed" ||
							representations[register] === "string",
					),
				})),
			},
		};
	});
	return {
		...fnWithoutGc,
		directEntries,
		...(fieldCallPlans.length === 0
			? {}
			: {
					fieldCalls: fieldCallPlans.map((site) => ({
						allocation: loweredInstructions.get(site.allocation)!,
						call: loweredInstructions.get(site.call)!,
						entries: site.entries,
					})),
				}),
		gc: { safepoints },
	};
}

function planCoreTargetRepresentation(
	representation: CorePlanRepresentation,
): CoreTargetRegisterRepresentation {
	if (representation === "f64") return "number";
	if (representation === "i32") return "int32";
	return representation;
}

/** Lower sealed Core directly into the generic runtime execution contract. */
export function lowerCoreCompilationToTargetProgram(
	compilation: CoreCompilation,
	options: LowerCoreToCoreTargetOptions,
): CoreTargetProgram {
	assertCoreOptimizationPlanCertificate(compilation.program, compilation.plan);
	const functionMap = createCoreTargetFunctionMap(compilation);
	const directEntryPlans = new Map<number, Array<CoreDirectEntryPlan>>();
	const directEntryIds = new Map<number, Map<CoreInstructionId, number>>();
	const numericSortCallbacks = new Map<
		number,
		Map<CoreInstructionId, CompilerNumericSortCallback>
	>();
	const fieldCallPlans = new Map<number, Map<CoreInstructionId, CoreFieldCall>>();
	const directEntryTargets = new Map<
		number,
		Map<CoreInstructionId, { target: CoreFunctionId; guarded: boolean }>
	>();
	const directBuiltinCallbacks = new Map<
		number,
		Map<CoreInstructionId, CoreFunctionId>
	>();
	const specializationRows = new Map<CoreFunctionId, Array<number>>();
	const blockOrders = new Map(
		compilation.plan.blockOrders.map(({ function: functionId, blocks }) => [
			functionId,
			blocks,
		]),
	);
	for (let row = 0; row < compilation.plan.recipes.count; row++) {
		if (
			options.excludeGuardedDirectCalls === true &&
			coreSpecializationRecipeKindAt(compilation.plan.recipes, row) ===
				"guarded-direct-call"
		)
			continue;
		const functionId = coreSpecializationRecipeFunctionAt(compilation.plan.recipes, row);
		const rows = specializationRows.get(functionId) ?? [];
		rows.push(row);
		specializationRows.set(functionId, rows);
	}
	for (const entry of compilation.plan.directEntries) {
		const entries = directEntryPlans.get(entry.function) ?? [];
		entries.push(entry);
		directEntryPlans.set(entry.function, entries);
		for (const site of entry.callSites) {
			if (site.numericSortCallback !== undefined) {
				const calls =
					numericSortCallbacks.get(site.caller) ??
					new Map<CoreInstructionId, CompilerNumericSortCallback>();
				calls.set(site.instruction, {
					operation: site.numericSortCallback,
					...(site.numericSortCallbackViaCall ? { viaCall: true as const } : {}),
					functionIndex: functionMap.coreToExecution[entry.function]!,
					entryId: entry.id,
				});
				numericSortCallbacks.set(site.caller, calls);
				continue;
			}
			if (site.fieldObject !== undefined) {
				const calls =
					fieldCallPlans.get(site.caller) ?? new Map<CoreInstructionId, CoreFieldCall>();
				const call = calls.get(site.instruction) ?? {
					allocation: site.fieldObject,
					call: site.instruction,
					entries: [],
				};
				call.entries.push({
					functionIndex: functionMap.coreToExecution[entry.function]!,
					entryId: entry.id,
				});
				calls.set(site.instruction, call);
				fieldCallPlans.set(site.caller, calls);
				continue;
			}
			const calls =
				directEntryIds.get(site.caller) ?? new Map<CoreInstructionId, number>();
			calls.set(site.instruction, entry.id);
			directEntryIds.set(site.caller, calls);
			const targets =
				directEntryTargets.get(site.caller) ??
				new Map<CoreInstructionId, { target: CoreFunctionId; guarded: boolean }>();
			targets.set(site.instruction, {
				target: entry.function,
				guarded: site.guarded === true,
			});
			directEntryTargets.set(site.caller, targets);
		}
	}
	for (const callback of compilation.plan.directBuiltinCallbacks ?? []) {
		const calls =
			directBuiltinCallbacks.get(callback.caller) ??
			new Map<CoreInstructionId, CoreFunctionId>();
		calls.set(callback.instruction, callback.target);
		directBuiltinCallbacks.set(callback.caller, calls);
	}
	const unsignedArithmetic = new Map<CoreFunctionId, Set<CoreInstructionId>>();
	for (const operation of compilation.plan.unsignedArithmetic ?? []) {
		let instructions = unsignedArithmetic.get(operation.function);
		if (instructions === undefined) {
			instructions = new Set();
			unsignedArithmetic.set(operation.function, instructions);
		}
		instructions.add(operation.instruction);
	}
	const privateNumericArrayElements = new Map<CoreFunctionId, Set<CoreInstructionId>>();
	for (const operation of compilation.plan.privateNumericArrayElements ?? []) {
		let instructions = privateNumericArrayElements.get(operation.function);
		if (instructions === undefined) {
			instructions = new Set();
			privateNumericArrayElements.set(operation.function, instructions);
		}
		instructions.add(operation.instruction);
	}
	const privatePackedRestArrayElements = new Map<
		CoreFunctionId,
		Array<CorePrivatePackedRestArrayElementPlan>
	>();
	for (const operation of compilation.plan.privatePackedRestArrayElements ?? []) {
		let instructions = privatePackedRestArrayElements.get(operation.function);
		if (instructions === undefined) {
			instructions = [];
			privatePackedRestArrayElements.set(operation.function, instructions);
		}
		instructions.push(operation);
	}
	const operatorInputs = new Map<
		CoreFunctionId,
		Map<CoreInstructionId, CompilerOperatorInputKindMasks>
	>();
	for (const operation of compilation.plan.operatorInputs ?? []) {
		let instructions = operatorInputs.get(operation.function);
		if (instructions === undefined) {
			instructions = new Map();
			operatorInputs.set(operation.function, instructions);
		}
		instructions.set(operation.instruction, operation.masks);
	}
	const builtinInputs = new Map<
		CoreFunctionId,
		Map<CoreInstructionId, ReadonlyArray<number>>
	>();
	for (const operation of compilation.plan.builtinInputs ?? []) {
		let instructions = builtinInputs.get(operation.function);
		if (instructions === undefined) {
			instructions = new Map();
			builtinInputs.set(operation.function, instructions);
		}
		instructions.set(operation.instruction, operation.masks);
	}
	const specializedOnly = new Set(compilation.plan.specializedOnlyFunctions ?? []);
	const functions = functionMap.executionToCore.map((core, execution) => ({
		...(specializedOnly.has(core) ? { specializedOnly: true as const } : {}),
		...lowerFunctionToTarget(
			compilation.program.function(core),
			execution,
			functionMap,
			directEntryIds.get(core) ?? new Map(),
			numericSortCallbacks.get(core) ?? new Map(),
			directEntryTargets.get(core) ?? new Map(),
			directEntryPlans.get(core) ?? [],
			directBuiltinCallbacks.get(core) ?? new Map(),
			[...(fieldCallPlans.get(core)?.values() ?? [])],
			unsignedArithmetic.get(core) ?? new Set(),
			privateNumericArrayElements.get(core) ?? new Set(),
			privatePackedRestArrayElements.get(core) ?? [],
			operatorInputs.get(core) ?? new Map(),
			builtinInputs.get(core) ?? new Map(),
			compilation.plan.recipes,
			specializationRows.get(core) ?? [],
			blockOrders.get(core)!,
			compilation.context.facts.sites,
			compilation.context.facts.instructionSites,
			options.assignStorage,
			options.loopBackedgeInstructions ?? executionLoopBackedgeInstructions,
			options.layoutBlocks,
			options.createParallelCopyLowerer,
			options.preserveResumableRepresentations === true,
		),
	}));
	return Object.freeze({
		core: compilation.program,
		context: compilation.context,
		functionMap,
		functions: Object.freeze(functions),
	});
}
