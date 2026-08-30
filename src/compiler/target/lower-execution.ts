import type { CoreCompilation } from "../core/core-compilation.ts";
import {
	CORE_CALLEE_TARGET_CAP,
	CORE_CALLEE_TARGETS_ATTRIBUTE,
	CORE_INTERNAL_TARGET_ATTRIBUTES,
} from "../core/core-ir-call-targets.ts";
import {
	buildCoreControlFlow,
	coreCanonicalValueRoots,
	coreTerminatorEdges,
} from "../core/core-ir-control-flow.ts";
import { coreOpcodeRegistry } from "../core/core-ir-opcodes.ts";
import {
	CORE_CONTAINED_AGGREGATE_OWN_SLOT_FACT,
	CORE_CONTAINED_DENSE_ARRAY_ELEMENT_ATTRIBUTE,
	CORE_FRESH_ARRAY_LENGTH_ATTRIBUTE,
	CORE_OWN_DATA_CELL_FACT,
} from "../core/core-ir-provenance.ts";
import type { CoreAllocatedRegion } from "../core/core-ir-regions.ts";
import {
	CORE_EXACT_SHAPE_OWN_SLOT_ATTRIBUTE,
	coreExactShapeOwnSlotFromAttribute,
} from "../core/core-ir-shape-provenance.ts";
import { CORE_INTERNAL_SUMMARY_ATTRIBUTES } from "../core/core-ir-summaries.ts";
import {
	CORE_EXACT_COLLECTION_RECEIVER_ATTRIBUTE,
	CORE_EXACT_TYPED_ARRAY_KIND_ATTRIBUTE,
	coreExactCollectionBrand,
	coreNumericTypedArrayKind,
} from "../core/core-ir-value-classes.ts";
import {
	CORE_EXACT_BINARY_INPUT_KIND_MASKS_ATTRIBUTE,
	CORE_EXACT_CALL_ARGUMENT_REPRESENTATIONS_ATTRIBUTE,
	CORE_EXACT_SCALAR_AFTER_TDZ_ATTRIBUTE,
	coreExactBinaryInputKindMasks,
} from "../core/core-ir-value-kinds.ts";
import { verifyCoreProgram } from "../core/core-ir-verifier.ts";
import type {
	CoreBlockId,
	CoreEdge,
	CoreFact,
	CoreFunction,
	CoreImmediate,
	CoreInstructionAttributes,
	CoreInstruction,
	CoreInstructionId,
	CoreRegion,
	CoreRepresentation,
	CoreValueId,
} from "../core/core-ir.ts";
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
	ExecutionDirectEntry,
	ExecutionMove,
	ExecutionParallelCopy,
	ExecutionProgram,
	ExecutionRegisterRepresentation,
	ExecutionSafepoint,
} from "./execution-ir.ts";
import {
	executionLoopBackedgeInstructions,
	executionSafepointRootRegisters,
} from "./execution-liveness.ts";
import { verifyExecutionProgram } from "./verify-execution.ts";
export type {
	ExecutionDirectEntry,
	ExecutionFunction,
	ExecutionMove,
	ExecutionParallelCopy,
	ExecutionProgram,
	ExecutionSafepoint,
} from "./execution-ir.ts";

export interface PlannedDirectEntry {
	readonly id: number;
	readonly parameterRepresentations: ReadonlyArray<
		"boxed" | "int32" | "number" | "boolean" | "string"
	>;
	readonly resultRepresentation: "boxed" | "int32" | "number" | "boolean" | "string";
}

export interface DirectEntryPlan {
	readonly entriesByFunction: ReadonlyArray<ReadonlyArray<PlannedDirectEntry>>;
	readonly entryByCall: ReadonlyMap<CoreInstruction, number>;
}

const RAW_ARGUMENT_OPCODES = new Set([
	"loadArgumentCount",
	"loadArgument",
	"loadStaticArgument",
	"createArgumentsObject",
	"createRestArguments",
]);

/** Whether the canonical ABI may acquire typed native-only entry siblings. */
export function coreSupportsDirectEntries(fn: CoreFunction): boolean {
	return (
		!fn.isGenerator &&
		!fn.isAsync &&
		!fn.metadata.isClassConstructor &&
		!fn.metadata.isDerivedConstructor &&
		!fn.metadata.mappedArguments &&
		!fn.blocks.some(({ instructions }) =>
			instructions.some(({ opcode }) => RAW_ARGUMENT_OPCODES.has(opcode)),
		)
	);
}

const CORE_INTERNAL_ATTRIBUTES: ReadonlySet<string> = new Set([
	...CORE_INTERNAL_TARGET_ATTRIBUTES,
	...CORE_INTERNAL_SUMMARY_ATTRIBUTES,
	CORE_CONTAINED_DENSE_ARRAY_ELEMENT_ATTRIBUTE,
	CORE_FRESH_ARRAY_LENGTH_ATTRIBUTE,
	CORE_EXACT_COLLECTION_RECEIVER_ATTRIBUTE,
	CORE_EXACT_TYPED_ARRAY_KIND_ATTRIBUTE,
	CORE_EXACT_BINARY_INPUT_KIND_MASKS_ATTRIBUTE,
	CORE_EXACT_CALL_ARGUMENT_REPRESENTATIONS_ATTRIBUTE,
	CORE_EXACT_SCALAR_AFTER_TDZ_ATTRIBUTE,
	CORE_EXACT_SHAPE_OWN_SLOT_ATTRIBUTE,
]);

interface LoweredParallelCopy {
	readonly moves: Array<ExecutionMove>;
	readonly temporaries: Array<number>;
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

/** Physical register class selected for a canonical Core representation. */
export function physicalRegisterClass(
	representation: CoreRepresentation,
): "boxed" | "int32" | "number" | "boolean" | "string" {
	if (representation === "i32") return "int32";
	if (representation === "f64") return "number";
	if (representation === "boolean") return "boolean";
	return representation === "string" ? "string" : "boxed";
}

/**
 * Attributes a target instruction may carry. Core-internal analysis metadata,
 * such as a call site's bounded target set, stops here: the only target-visible
 * product of that analysis is the exact call `directFunctionIndex` lowering.
 */
function targetAttributes(
	attributes: CoreInstructionAttributes,
): CoreInstructionAttributes {
	for (const key of CORE_INTERNAL_ATTRIBUTES) {
		if (!(key in attributes)) continue;
		return Object.fromEntries(
			Object.entries(attributes).filter(
				([entry]) => !CORE_INTERNAL_ATTRIBUTES.has(entry),
			),
		);
	}
	return attributes;
}

function guardedCallTargets(
	instruction: CoreInstruction,
): ReadonlyArray<number> | undefined {
	if (
		instruction.opcode !== "call" ||
		typeof instruction.attributes.directFunctionIndex === "number"
	) {
		return undefined;
	}
	const attribute = instruction.attributes[CORE_CALLEE_TARGETS_ATTRIBUTE];
	if (attribute === null || typeof attribute !== "object" || Array.isArray(attribute)) {
		return undefined;
	}
	const functions = (attribute as { readonly functions?: unknown }).functions;
	if (
		!Array.isArray(functions) ||
		functions.length === 0 ||
		functions.length > CORE_CALLEE_TARGET_CAP ||
		!functions.every(
			(target, index) =>
				typeof target === "number" &&
				Number.isSafeInteger(target) &&
				target >= 0 &&
				(index === 0 || target > functions[index - 1]!),
		)
	) {
		return undefined;
	}
	return functions as ReadonlyArray<number>;
}

/**
 * Materialize Core's independently re-proved containment certificate as the
 * physical slot it names. The fact is intentionally consumed here, after the
 * pre-target verifier has reconstructed allocation provenance: the backend does
 * not rediscover escape or shape facts, and no descriptive Core fact payload is
 * allowed to become native authority on its own.
 */
function exactContainedOwnSlot(
	index: CoreLoweringIndex,
	instruction: CoreInstruction,
): number | undefined {
	if (
		(instruction.opcode !== "loadPropertyStatic" &&
			instruction.opcode !== "storePropertyStatic") ||
		instruction.effectRefinement === undefined
	) {
		return undefined;
	}
	const fact = index.facts[instruction.effectRefinement.proof];
	if (fact?.kind === CORE_CONTAINED_AGGREGATE_OWN_SLOT_FACT) {
		const value =
			typeof fact.value === "object" && fact.value !== null
				? (fact.value as Record<string, unknown>)
				: undefined;
		return typeof value?.slot === "number" &&
			Number.isSafeInteger(value.slot) &&
			value.slot >= 0
			? value.slot
			: undefined;
	}
	if (fact?.kind !== CORE_OWN_DATA_CELL_FACT) return undefined;
	const value =
		typeof fact.value === "object" && fact.value !== null
			? (fact.value as Record<string, unknown>)
			: undefined;
	const cell =
		typeof value?.cell === "object" && value.cell !== null
			? (value.cell as Record<string, unknown>)
			: undefined;
	if (
		typeof value?.allocation !== "number" ||
		cell?.kind !== "object-slot" ||
		typeof cell.key !== "number"
	) {
		return undefined;
	}
	const allocation = index.instructions[value.allocation];
	if (allocation?.opcode !== "createObjectShaped") return undefined;
	const keys = allocation.attributes.keyStringIndices;
	if (!Array.isArray(keys)) return undefined;
	const slot = keys.indexOf(cell.key);
	return slot >= 0 ? slot : undefined;
}

function rebuildInstruction(
	loweringIndex: CoreLoweringIndex,
	instruction: CoreFunction["blocks"][number]["instructions"][number],
	registerForValue: (value: CoreValueId) => number,
	regionNamed: boolean,
	forceBoxed: boolean,
): CompilerInstruction {
	const contract = requireCoreTargetOperationContract(instruction.opcode);
	const registers = [...instruction.outputs, ...instruction.inputs].map(registerForValue);
	const exactShapeOwnSlot = coreExactShapeOwnSlotFromAttribute(
		instruction.attributes[CORE_EXACT_SHAPE_OWN_SLOT_ATTRIBUTE],
	);
	const exactOwnSlot =
		exactContainedOwnSlot(loweringIndex, instruction) ?? exactShapeOwnSlot?.slot;
	const exactArrayLength =
		instruction.opcode === "loadPropertyStatic" &&
		instruction.attributes[CORE_FRESH_ARRAY_LENGTH_ATTRIBUTE] === true;
	const exactContainedArrayElement =
		instruction.opcode === "loadProperty" &&
		instruction.attributes[CORE_CONTAINED_DENSE_ARRAY_ELEMENT_ATTRIBUTE] === true;
	const exactTypedArrayKind =
		instruction.opcode === "loadProperty"
			? coreNumericTypedArrayKind(
					instruction.attributes[CORE_EXACT_TYPED_ARRAY_KIND_ATTRIBUTE],
				)
			: undefined;
	const exactCollectionReceiver =
		instruction.opcode === "call"
			? coreExactCollectionBrand(
					instruction.attributes[CORE_EXACT_COLLECTION_RECEIVER_ATTRIBUTE],
				)
			: undefined;
	const exactInputKindMasks =
		instruction.opcode === "binary"
			? coreExactBinaryInputKindMasks(
					instruction.attributes[CORE_EXACT_BINARY_INPUT_KIND_MASKS_ATTRIBUTE],
				)
			: undefined;
	const exactScalarAfterTdz =
		!forceBoxed &&
		instruction.opcode === "move" &&
		(instruction.attributes[CORE_EXACT_SCALAR_AFTER_TDZ_ATTRIBUTE] === "int32" ||
			instruction.attributes[CORE_EXACT_SCALAR_AFTER_TDZ_ATTRIBUTE] === "number" ||
			instruction.attributes[CORE_EXACT_SCALAR_AFTER_TDZ_ATTRIBUTE] === "boolean" ||
			instruction.attributes[CORE_EXACT_SCALAR_AFTER_TDZ_ATTRIBUTE] === "string")
			? {
					kind: instruction.attributes[CORE_EXACT_SCALAR_AFTER_TDZ_ATTRIBUTE],
					coreInstruction: instruction.id,
				}
			: undefined;
	const immediateValues: Array<CompilerImmediateValue | undefined> = [];
	// A region certificate's contract is stated over the instruction's operands, so
	// embedding one of them as a constant would change the shape the certificate
	// describes even though the producer stays materialized.
	if (
		!regionNamed &&
		(instruction.opcode === "call" ||
			instruction.opcode === "callBuiltin" ||
			instruction.opcode === "construct")
	) {
		for (const [index, input] of instruction.inputs.entries()) {
			const value = coreImmediateValue(loweringIndex, input);
			if (value === undefined) continue;
			const position = instruction.outputs.length + index;
			registers[position] = -1;
			immediateValues[position] = value;
		}
	}
	const guardedFunctionIndices = guardedCallTargets(instruction);
	return {
		type: contract.targetType,
		...targetAttributes(instruction.attributes),
		...(guardedFunctionIndices === undefined ? {} : { guardedFunctionIndices }),
		...(exactOwnSlot === undefined ? {} : { exactOwnSlot }),
		...(exactArrayLength ? { exactArrayLength: true } : {}),
		...(exactContainedArrayElement ? { exactContainedArrayElement: true } : {}),
		...(exactTypedArrayKind === undefined ? {} : { exactTypedArrayKind }),
		...(exactCollectionReceiver === undefined ? {} : { exactCollectionReceiver }),
		...(exactInputKindMasks === undefined ? {} : { exactInputKindMasks }),
		...(exactScalarAfterTdz === undefined ? {} : { exactScalarAfterTdz }),
		...(immediateValues.length === 0 ? {} : { immediateValues }),
		...(["asyncStart", "generatorStart", "initGlobalVars"].includes(instruction.opcode)
			? {}
			: { registers }),
	} as CompilerInstruction;
}

interface CoreLoweringIndex {
	readonly values: ReadonlyArray<CoreFunction["values"][number] | undefined>;
	readonly facts: ReadonlyArray<CoreFact | undefined>;
	readonly instructions: ReadonlyArray<CoreInstruction | undefined>;
}

function coreLoweringIndex(core: CoreFunction): CoreLoweringIndex {
	const values: Array<CoreFunction["values"][number] | undefined> = [];
	for (const value of core.values) values[value.id] = value;
	const facts: Array<CoreFact | undefined> = [];
	for (const fact of core.facts) facts[fact.id] = fact;
	const instructions: Array<CoreInstruction | undefined> = [];
	for (const block of core.blocks) {
		for (const instruction of block.instructions) {
			instructions[instruction.id] = instruction;
		}
	}
	return { values, facts, instructions };
}

function coreImmediateValue(
	index: CoreLoweringIndex,
	value: CoreValueId,
): CompilerImmediateValue | undefined {
	const definition = index.values[value]?.definition;
	if (definition?.kind !== "instruction") return undefined;
	const instruction = index.instructions[definition.instruction];
	if (instruction === undefined || definition.index !== 0) return undefined;
	switch (instruction.opcode) {
		case "createUndefined":
			return { kind: "undefined" };
		case "createNull":
			return { kind: "null" };
		case "createBoolean":
			return typeof instruction.attributes.value === "boolean"
				? { kind: "boolean", value: instruction.attributes.value }
				: undefined;
		case "createNumber":
		case "createF64": {
			const number = instruction.attributes.value;
			return typeof number === "number" &&
				Number.isInteger(number) &&
				!Object.is(number, -0) &&
				number >= -0x0800_0000 &&
				number <= 0x07ff_ffff
				? { kind: "number", value: number }
				: undefined;
		}
		case "createString": {
			const index = instruction.attributes.stringIndex;
			return typeof index === "number" && index <= 0x0fff_ffff
				? { kind: "string", index }
				: undefined;
		}
		default:
			return undefined;
	}
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

function lowerCoreRegionData(
	value: unknown,
	instructions: ReadonlyMap<CoreInstructionId, CompilerInstruction>,
	blocks: ReadonlyMap<CoreBlockId, number>,
	values: ReadonlyMap<CoreValueId, number>,
): unknown {
	if (value === undefined || value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) {
		return value.map((entry) => lowerCoreRegionData(entry, instructions, blocks, values));
	}
	const object = value as Readonly<Record<string, unknown>>;
	if (Object.keys(object).length === 1 && typeof object.$coreInstruction === "number") {
		const instruction = instructions.get(object.$coreInstruction as CoreInstructionId);
		if (instruction === undefined) {
			throw new Error(
				`Core region lowering lost instruction @${object.$coreInstruction}`,
			);
		}
		return instruction;
	}
	if (Object.keys(object).length === 1 && typeof object.$coreBlock === "number") {
		const block = blocks.get(object.$coreBlock as CoreBlockId);
		if (block === undefined) {
			throw new Error(`Core region lowering lost block b${object.$coreBlock}`);
		}
		return block;
	}
	if (Object.keys(object).length === 1 && typeof object.$coreValue === "number") {
		const register = values.get(object.$coreValue as CoreValueId);
		if (register === undefined) {
			throw new Error(`Core region lowering lost value %${object.$coreValue}`);
		}
		return register;
	}
	const result: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(object)) {
		result[key] = lowerCoreRegionData(entry, instructions, blocks, values);
	}
	return result;
}

function lowerCoreRegions(
	regions: ReadonlyArray<CoreRegion>,
	instructions: ReadonlyMap<CoreInstructionId, CompilerInstruction>,
	blocks: ReadonlyMap<CoreBlockId, number>,
	values: ReadonlyMap<CoreValueId, number>,
): ReadonlyArray<CoreAllocatedRegion> {
	if (regions.length === 0) return [];
	const requireInstruction = (id: CoreInstructionId): CompilerInstruction => {
		const instruction = instructions.get(id);
		if (instruction === undefined) {
			throw new Error(`Core region lowering lost instruction @${id}`);
		}
		return instruction;
	};
	const requireBlock = (id: CoreBlockId): number => {
		const block = blocks.get(id);
		if (block === undefined) throw new Error(`Core region lowering lost block b${id}`);
		return block;
	};
	return regions.map((region) => ({
		...(lowerCoreRegionData(region.data, instructions, blocks, values) as object),
		kind: region.kind,
		anchors: region.anchors.map(requireInstruction),
		claimedInstructions: region.claimedInstructions.map(requireInstruction),
		controlFlow: {
			ordinaryBlocks: region.ordinaryBlocks.map(requireBlock),
			exceptionalBlocks: region.exceptionalBlocks.map(requireBlock),
		},
	})) as unknown as ReadonlyArray<CoreAllocatedRegion>;
}

export function coreRegisterClasses(
	core: CoreFunction,
	reuseRegisters = true,
	reservedAbiColors: ReadonlySet<number> = new Set(),
): {
	readonly roots: ReadonlyMap<CoreValueId, CoreValueId>;
	readonly registers: Map<CoreValueId, number>;
	readonly registerRepresentations: Map<number, CoreRepresentation>;
	/** Core instructions whose refined effects make them collection points. */
	readonly safepoints: ReadonlySet<CoreInstructionId>;
} {
	const representations = new Map(
		core.values.map(({ id, representation }) => [id, representation]),
	);
	const uses = core.blocks.map(() => new Set<CoreValueId>());
	const definitions = core.blocks.map(() => new Set<CoreValueId>());
	const successors = core.blocks.map(() => new Set<CoreBlockId>());
	const handlerParameters = (
		block: CoreFunction["blocks"][number],
	): ReadonlyArray<CoreValueId> => {
		if (block.handler === undefined) return [];
		const target = core.blocks[block.handler.block];
		if (target === undefined || target.parameters[0]?.role !== "exception") {
			throw new Error(`Core handler b${block.handler.block} has no exception parameter`);
		}
		const parameters = target.parameters.slice(1).map(({ value }) => value);
		if (parameters.length !== block.handler.arguments.length) {
			throw new Error(
				`Core handler b${block.handler.block} expects ${parameters.length} explicit arguments, received ${block.handler.arguments.length}`,
			);
		}
		return parameters;
	};
	const terminatorValues = (
		block: CoreFunction["blocks"][number],
	): Array<CoreValueId> => {
		const edgeArguments = coreTerminatorEdges(block.terminator).flatMap(
			(edge) => edge.arguments,
		);
		switch (block.terminator.kind) {
			case "branch":
			case "guard":
				return [block.terminator.condition, ...edgeArguments];
			case "switch":
				return [block.terminator.discriminant, ...edgeArguments];
			case "return":
			case "throw":
				return [block.terminator.value];
			case "jump":
				return edgeArguments;
			case "unreachable":
				return [];
		}
	};
	const blockTerminatorValues = core.blocks.map(terminatorValues);
	for (const block of core.blocks) {
		const blockUses = uses[block.id]!;
		const blockDefinitions = definitions[block.id]!;
		for (const { value } of block.parameters) blockDefinitions.add(value);
		const addUse = (value: CoreValueId): void => {
			if (!blockDefinitions.has(value)) blockUses.add(value);
		};
		for (const instruction of block.instructions) {
			for (const input of instruction.inputs) addUse(input);
			for (const output of instruction.outputs) blockDefinitions.add(output);
		}
		for (const value of blockTerminatorValues[block.id]!) addUse(value);
		for (const argument of block.handler?.arguments ?? []) addUse(argument);
		for (const edge of coreTerminatorEdges(block.terminator)) {
			successors[block.id]!.add(edge.block);
		}
		if (block.handler !== undefined) successors[block.id]!.add(block.handler.block);
	}
	const liveIn = core.blocks.map((_, index) => new Set(uses[index]));
	const liveOut = core.blocks.map(() => new Set<CoreValueId>());
	const predecessors = core.blocks.map(() => new Array<CoreBlockId>());
	for (const block of core.blocks) {
		for (const successor of successors[block.id]!) {
			predecessors[successor]!.push(block.id);
		}
	}
	const pending = core.blocks.map(({ id }) => id);
	const queued = new Uint8Array(core.blocks.length);
	queued.fill(1);
	const liveInOrder = liveIn.map((values) => [...values]);
	const propagated = new Uint32Array(core.blocks.length);
	while (pending.length > 0) {
		const index = pending.pop()!;
		queued[index] = 0;
		const order = liveInOrder[index]!;
		const start = propagated[index]!;
		const end = order.length;
		propagated[index] = end;
		for (const predecessor of predecessors[index]!) {
			const predecessorOut = liveOut[predecessor]!;
			const predecessorIn = liveIn[predecessor]!;
			const predecessorDefinitions = definitions[predecessor]!;
			let inputChanged = false;
			for (let valueIndex = start; valueIndex < end; valueIndex++) {
				const value = order[valueIndex]!;
				predecessorOut.add(value);
				if (predecessorDefinitions.has(value) || predecessorIn.has(value)) continue;
				predecessorIn.add(value);
				liveInOrder[predecessor]!.push(value);
				inputChanged = true;
			}
			if (!inputChanged || queued[predecessor] !== 0) continue;
			queued[predecessor] = 1;
			pending.push(predecessor);
		}
	}
	// Target edge lowering emits parallel copies for distinct block arguments. Moves
	// and single-source ordinary phis are semantic aliases, however, and must retain
	// one register both to erase their redundant copies and to preserve region
	// contracts selected over canonical values. Sparse per-block ranges keep mutually
	// exclusive paths disjoint without rebuilding the dense pairwise interference
	// graph that made large self-hosted functions quadratic.
	interface LiveInterval {
		readonly value: CoreValueId;
		start: number;
		end: number;
		readonly blockRanges: Map<CoreBlockId, { start: number; end: number }>;
	}
	const intervals = new Array<LiveInterval | undefined>(
		(core.values.at(-1)?.id ?? -1) + 1,
	);
	for (const { id } of core.values) {
		intervals[id] = {
			value: id,
			start: Number.POSITIVE_INFINITY,
			end: Number.NEGATIVE_INFINITY,
			blockRanges: new Map(),
		};
	}
	const touch = (
		value: CoreValueId,
		block: CoreBlockId,
		position: number,
		blockPosition: number,
	): void => {
		const interval = intervals[value];
		if (interval === undefined) throw new Error(`Core allocation lost value %${value}`);
		interval.start = Math.min(interval.start, position);
		interval.end = Math.max(interval.end, position);
		const range = interval.blockRanges.get(block);
		if (range === undefined) {
			interval.blockRanges.set(block, {
				start: blockPosition,
				end: blockPosition,
			});
		} else {
			range.start = Math.min(range.start, blockPosition);
			range.end = Math.max(range.end, blockPosition);
		}
	};
	let nextPosition = 0;
	for (const block of core.blocks) {
		const blockStart = nextPosition++;
		for (const { value } of block.parameters) touch(value, block.id, blockStart, 0);
		for (const value of liveIn[block.id]!) touch(value, block.id, blockStart, 0);
		for (const [instructionIndex, instruction] of block.instructions.entries()) {
			const position = nextPosition++;
			for (const input of instruction.inputs)
				touch(input, block.id, position, instructionIndex + 1);
			for (const output of instruction.outputs)
				touch(output, block.id, position, instructionIndex + 1);
		}
		const blockEnd = nextPosition++;
		const blockEndPosition = block.instructions.length + 1;
		for (const value of blockTerminatorValues[block.id]!)
			touch(value, block.id, blockEnd, blockEndPosition);
		for (const argument of block.handler?.arguments ?? [])
			touch(argument, block.id, blockEnd, blockEndPosition);
		for (const value of liveOut[block.id]!)
			touch(value, block.id, blockEnd, blockEndPosition);
		// Handler parameters are initialized before the protected block executes and
		// must remain intact at every instruction that can transfer to the handler.
		for (const parameter of handlerParameters(block)) {
			touch(parameter, block.id, blockStart, 0);
			touch(parameter, block.id, blockEnd, blockEndPosition);
		}
	}
	for (const interval of intervals) {
		if (interval === undefined) continue;
		if (!Number.isFinite(interval.start)) {
			throw new Error(`Core allocation found unused value %${interval.value}`);
		}
	}
	const controlFlow = buildCoreControlFlow(core, coreOpcodeRegistry);
	const semanticRoots = coreCanonicalValueRoots(core, controlFlow);
	const classRootsByRepresentation: Record<
		CoreRepresentation,
		Map<CoreValueId, CoreValueId>
	> = {
		boxed: new Map(),
		f64: new Map(),
		i32: new Map(),
		boolean: new Map(),
		string: new Map(),
		"string-span": new Map(),
		"projected-elements": new Map(),
		"dense-elements": new Map(),
		"scalarized-object": new Map(),
	};
	const roots = new Map<CoreValueId, CoreValueId>();
	for (const { id, representation } of core.values) {
		const semanticRoot = semanticRoots.get(id)!;
		const classRoots = classRootsByRepresentation[representation];
		let root = classRoots.get(semanticRoot);
		if (root === undefined) {
			root = id;
			classRoots.set(semanticRoot, root);
		}
		roots.set(id, root);
	}
	// Shape-case results are live certificates and cannot use two-address overwrite colors.
	const shapeCaseRoots = new Set(
		core.blocks.flatMap(({ instructions }) =>
			instructions.flatMap((instruction) =>
				instruction.opcode === "selectShapeCase"
					? instruction.outputs.map((output) => roots.get(output)!)
					: [],
			),
		),
	);
	const classIntervals = new Map<CoreValueId, LiveInterval>();
	for (const interval of intervals) {
		if (interval === undefined) continue;
		const root = roots.get(interval.value)!;
		const existing = classIntervals.get(root);
		if (existing === undefined) {
			classIntervals.set(root, {
				...interval,
				value: root,
				blockRanges: new Map(
					[...interval.blockRanges].map(([block, range]) => [block, { ...range }]),
				),
			});
		} else {
			existing.start = Math.min(existing.start, interval.start);
			existing.end = Math.max(existing.end, interval.end);
			for (const [block, range] of interval.blockRanges) {
				const current = existing.blockRanges.get(block);
				if (current === undefined) {
					existing.blockRanges.set(block, { ...range });
				} else {
					current.start = Math.min(current.start, range.start);
					current.end = Math.max(current.end, range.end);
				}
			}
		}
	}
	const abi = new Map<CoreValueId, number>(
		core.parameters.map((value, index) => [value, index]),
	);
	let snapshotIndex = 0;
	for (const instruction of core.blocks[core.entry]!.instructions) {
		if (
			instruction.opcode !== "loadArgumentCount" &&
			instruction.opcode !== "loadArgument"
		) {
			break;
		}
		const output = instruction.outputs[0];
		if (output !== undefined) {
			abi.set(output, core.parameters.length + snapshotIndex++);
		}
	}
	const abiRoots = new Map<CoreValueId, number>();
	for (const [value, color] of abi) {
		const root = roots.get(value)!;
		const existing = abiRoots.get(root);
		if (existing !== undefined && existing !== color) {
			throw new Error(`Core canonical class %${root} spans ABI registers`);
		}
		abiRoots.set(root, color);
	}
	const copyPartners = new Map<CoreValueId, Set<CoreValueId>>();
	const copyPairKey = (left: CoreValueId, right: CoreValueId): string =>
		left < right ? `${left}:${right}` : `${right}:${left}`;
	const addCopyCandidate = (leftValue: CoreValueId, rightValue: CoreValueId): void => {
		const left = roots.get(leftValue)!;
		const right = roots.get(rightValue)!;
		if (
			left === right ||
			shapeCaseRoots.has(left) ||
			shapeCaseRoots.has(right) ||
			representations.get(left) !== representations.get(right)
		)
			return;
		const leftPartners = copyPartners.get(left) ?? new Set<CoreValueId>();
		leftPartners.add(right);
		copyPartners.set(left, leftPartners);
		const rightPartners = copyPartners.get(right) ?? new Set<CoreValueId>();
		rightPartners.add(left);
		copyPartners.set(right, rightPartners);
	};
	for (const block of core.blocks) {
		for (const edge of controlFlow.predecessors[block.id]!) {
			if (edge.kind !== "ordinary") continue;
			for (const [index, parameter] of block.parameters.entries()) {
				const argument = edge.arguments[index];
				if (argument !== undefined) addCopyCandidate(parameter.value, argument);
			}
		}
		for (const instruction of block.instructions) {
			const output = instruction.outputs[0];
			if (
				output === undefined ||
				instruction.outputs.length !== 1 ||
				(instruction.opcode !== "unary" && instruction.opcode !== "binary")
			) {
				continue;
			}
			for (const input of instruction.inputs) addCopyCandidate(output, input);
		}
	}
	// Interference is only needed for optional edge-copy preferences. Check that
	// sparse candidate set against exact reverse liveness instead of materializing
	// every pair in the function.
	const conflictingCopyPairs = new Set<string>();
	for (const block of core.blocks) {
		const live = new Set<CoreValueId>();
		const liveRootCounts = new Map<CoreValueId, number>();
		const addLive = (value: CoreValueId): void => {
			if (live.has(value)) return;
			live.add(value);
			const root = roots.get(value)!;
			liveRootCounts.set(root, (liveRootCounts.get(root) ?? 0) + 1);
		};
		const removeLive = (value: CoreValueId): void => {
			if (!live.delete(value)) return;
			const root = roots.get(value)!;
			const remaining = liveRootCounts.get(root)! - 1;
			if (remaining === 0) liveRootCounts.delete(root);
			else liveRootCounts.set(root, remaining);
		};
		const markLiveConflicts = (value: CoreValueId): void => {
			const root = roots.get(value)!;
			for (const partner of copyPartners.get(root) ?? []) {
				if ((liveRootCounts.get(partner) ?? 0) > 0) {
					conflictingCopyPairs.add(copyPairKey(root, partner));
				}
			}
		};
		for (const value of liveOut[block.id]!) addLive(value);
		for (const value of blockTerminatorValues[block.id]!) addLive(value);
		for (const parameter of handlerParameters(block)) addLive(parameter);
		for (let index = block.instructions.length - 1; index >= 0; index--) {
			const instruction = block.instructions[index]!;
			for (const output of instruction.outputs) markLiveConflicts(output);
			for (const [outputIndex, output] of instruction.outputs.entries()) {
				for (const other of instruction.outputs.slice(outputIndex + 1)) {
					const left = roots.get(output)!;
					const right = roots.get(other)!;
					if (copyPartners.get(left)?.has(right) === true) {
						conflictingCopyPairs.add(copyPairKey(left, right));
					}
				}
				removeLive(output);
			}
			for (const input of instruction.inputs) addLive(input);
		}
		for (const { value } of block.parameters) markLiveConflicts(value);
		for (const [parameterIndex, parameter] of block.parameters.entries()) {
			for (const other of block.parameters.slice(parameterIndex + 1)) {
				const left = roots.get(parameter.value)!;
				const right = roots.get(other.value)!;
				if (copyPartners.get(left)?.has(right) === true) {
					conflictingCopyPairs.add(copyPairKey(left, right));
				}
			}
		}
	}
	const copyCompatible = (left: CoreValueId, right: CoreValueId): boolean =>
		left === right ||
		(copyPartners.get(left)?.has(right) === true &&
			!conflictingCopyPairs.has(copyPairKey(left, right)));
	const registers = new Map<CoreValueId, number>();
	const colorRepresentations = new Map<number, CoreRepresentation>();
	for (const [root, color] of abiRoots) {
		registers.set(root, color);
		colorRepresentations.set(color, representations.get(root)!);
	}
	let nextUniqueColor = Math.max(-1, ...registers.values()) + 1;
	const orderedIntervals = [...classIntervals.values()].sort(
		(left, right) =>
			left.start - right.start || left.end - right.end || left.value - right.value,
	);
	const rootsByColor = new Map<number, Array<CoreValueId>>();
	for (const [root, color] of abiRoots) rootsByColor.set(color, [root]);
	const blockRangesByColor = new Map<
		number,
		Map<CoreBlockId, Array<{ start: number; end: number }>>
	>();
	const certificateColors = new Set<number>();
	const intervalsOverlap = (left: LiveInterval, right: LiveInterval): boolean => {
		const ranges =
			left.blockRanges.size <= right.blockRanges.size
				? left.blockRanges
				: right.blockRanges;
		const other = ranges === left.blockRanges ? right.blockRanges : left.blockRanges;
		for (const [block, range] of ranges) {
			const candidate = other.get(block);
			if (
				candidate !== undefined &&
				range.start <= candidate.end &&
				candidate.start <= range.end
			) {
				return true;
			}
		}
		return false;
	};
	const colorRangesOverlap = (color: number, interval: LiveInterval): boolean => {
		const byBlock = blockRangesByColor.get(color);
		if (byBlock === undefined) return false;
		for (const [block, range] of interval.blockRanges) {
			for (const candidate of byBlock.get(block) ?? []) {
				if (candidate.start > range.end) break;
				if (range.start <= candidate.end) return true;
			}
		}
		return false;
	};
	const addColorRanges = (color: number, interval: LiveInterval): void => {
		const byBlock =
			blockRangesByColor.get(color) ??
			new Map<CoreBlockId, Array<{ start: number; end: number }>>();
		for (const [block, range] of interval.blockRanges) {
			const ranges = byBlock.get(block) ?? [];
			const first = ranges.findIndex((candidate) => candidate.end + 1 >= range.start);
			if (first < 0) {
				ranges.push({ ...range });
				byBlock.set(block, ranges);
				continue;
			}
			if (ranges[first]!.start > range.end + 1) {
				ranges.splice(first, 0, { ...range });
				byBlock.set(block, ranges);
				continue;
			}
			let end = first;
			let start = Math.min(ranges[first]!.start, range.start);
			let finish = Math.max(ranges[first]!.end, range.end);
			while (end + 1 < ranges.length && ranges[end + 1]!.start <= finish + 1) {
				end++;
				start = Math.min(start, ranges[end]!.start);
				finish = Math.max(finish, ranges[end]!.end);
			}
			ranges.splice(first, end - first + 1, { start, end: finish });
			byBlock.set(block, ranges);
		}
		blockRangesByColor.set(color, byBlock);
	};
	for (const [root, color] of abiRoots) {
		addColorRanges(color, classIntervals.get(root)!);
	}
	const colorAvailable = (
		color: number,
		interval: LiveInterval,
		representation: CoreRepresentation,
		allowCopyOverlap = false,
	): boolean => {
		if (
			reservedAbiColors.has(color) ||
			certificateColors.has(color) ||
			(colorRepresentations.has(color) &&
				colorRepresentations.get(color) !== representation)
		) {
			return false;
		}
		if (!colorRangesOverlap(color, interval)) return true;
		if (!allowCopyOverlap) return false;
		return (rootsByColor.get(color) ?? []).every((root) => {
			if (copyCompatible(interval.value, root)) return true;
			return !intervalsOverlap(interval, classIntervals.get(root)!);
		});
	};
	const assignColor = (
		interval: LiveInterval,
		color: number,
		representation: CoreRepresentation,
	): void => {
		registers.set(interval.value, color);
		colorRepresentations.set(color, representation);
		const colored = rootsByColor.get(color) ?? [];
		colored.push(interval.value);
		rootsByColor.set(color, colored);
		addColorRanges(color, interval);
		nextUniqueColor = Math.max(nextUniqueColor, color + 1);
	};
	for (const interval of orderedIntervals) {
		const fixedColor = abiRoots.get(interval.value);
		if (fixedColor !== undefined) {
			const conflicts = (rootsByColor.get(fixedColor) ?? []).some(
				(root) =>
					root !== interval.value &&
					!copyCompatible(root, interval.value) &&
					intervalsOverlap(classIntervals.get(root)!, interval),
			);
			if (conflicts)
				throw new Error(`Core ABI register r${fixedColor} overlaps another live value`);
			continue;
		}
		const representation = representations.get(interval.value)!;
		if (shapeCaseRoots.has(interval.value)) {
			const color = nextUniqueColor;
			assignColor(interval, color, representation);
			certificateColors.add(color);
			continue;
		}
		if (!reuseRegisters) {
			assignColor(interval, nextUniqueColor, representation);
			continue;
		}
		const preferredColor = [...(copyPartners.get(interval.value) ?? [])]
			.map((partner) => registers.get(partner))
			.find((candidate): candidate is number => {
				if (candidate === undefined) return false;
				return colorAvailable(candidate, interval, representation, true);
			});
		let color = preferredColor ?? 0;
		if (preferredColor === undefined) {
			while (!colorAvailable(color, interval, representation)) color++;
		}
		assignColor(interval, color, representation);
	}
	const safepoints = new Set<CoreInstructionId>(
		core.blocks.flatMap(({ instructions }) =>
			instructions.flatMap((instruction) =>
				coreInstructionNeedsOperationSafepoint(instruction) ? [instruction.id] : [],
			),
		),
	);
	return {
		roots,
		registers,
		registerRepresentations: colorRepresentations,
		safepoints,
	};
}

function coreRegionInstructionIds(core: CoreFunction): ReadonlySet<CoreInstructionId> {
	const result = new Set<CoreInstructionId>();
	const visit = (value: unknown): void => {
		if (value === undefined || value === null || typeof value !== "object") return;
		if (Array.isArray(value)) {
			for (const entry of value) visit(entry);
			return;
		}
		const object = value as Readonly<Record<string, unknown>>;
		if (Object.keys(object).length === 1 && typeof object.$coreInstruction === "number") {
			result.add(object.$coreInstruction as CoreInstructionId);
			return;
		}
		for (const entry of Object.values(object)) visit(entry);
	};
	for (const region of core.regions) {
		for (const id of region.anchors) result.add(id);
		for (const id of region.claimedInstructions) result.add(id);
		visit(region.data);
	}
	return result;
}

/**
 * Constant producers whose every consumer embeds them as a call-like operand. Encoding
 * only: the operand still realizes the same constant at the same call, so the
 * omission removes no Core operation and grants no license. A region certificate
 * names both ends out of embedding — the producer so it stays materialized, and
 * the consuming call so its operands keep the shape the certificate's contract is
 * stated over — and both decisions read the same protected set here so they cannot
 * disagree. `ExecutionSafepoint` re-attributes an omitted producer's collection
 * point to the consuming call.
 */
function immediateOnlyInstructions(
	core: CoreFunction,
	index: CoreLoweringIndex,
	protectedInstructions: ReadonlySet<CoreInstructionId>,
): ReadonlySet<CoreInstructionId> {
	const embedded = new Set<CoreValueId>();
	const ordinary = new Set<CoreValueId>();
	for (const block of core.blocks) {
		for (const instruction of block.instructions) {
			for (const input of instruction.inputs) {
				if (
					(instruction.opcode === "call" ||
						instruction.opcode === "callBuiltin" ||
						instruction.opcode === "construct") &&
					!protectedInstructions.has(instruction.id) &&
					coreImmediateValue(index, input) !== undefined
				) {
					embedded.add(input);
				} else {
					ordinary.add(input);
				}
			}
		}
		const ordinaryTerminatorUse = (value: CoreValueId): void => {
			ordinary.add(value);
		};
		switch (block.terminator.kind) {
			case "branch":
			case "guard":
				ordinaryTerminatorUse(block.terminator.condition);
				break;
			case "switch":
				ordinaryTerminatorUse(block.terminator.discriminant);
				break;
			case "return":
			case "throw":
				ordinaryTerminatorUse(block.terminator.value);
				break;
			case "jump":
			case "unreachable":
				break;
		}
		for (const edge of coreTerminatorEdges(block.terminator)) {
			for (const argument of edge.arguments) ordinaryTerminatorUse(argument);
		}
		for (const argument of block.handler?.arguments ?? [])
			ordinaryTerminatorUse(argument);
	}
	return new Set(
		core.blocks.flatMap((block) =>
			block.instructions.flatMap((instruction) =>
				!protectedInstructions.has(instruction.id) &&
				instruction.outputs.length > 0 &&
				instruction.outputs.every(
					(output) => embedded.has(output) && !ordinary.has(output),
				)
					? [instruction.id]
					: [],
			),
		),
	);
}

/**
 * Reverse-postorder layout of every Core block. Layout only decides which block is
 * emitted next; it never removes a block or retargets an edge, so no optimization
 * decision can depend on it. Empty-block forwarding belongs to Core.
 */
function coreBlockLayout(core: CoreFunction): Array<CoreBlockId> {
	const successors = (block: CoreFunction["blocks"][number]): Array<CoreBlockId> => {
		const exceptional = block.handler === undefined ? [] : [block.handler.block];
		switch (block.terminator.kind) {
			case "jump":
				return [...exceptional, block.terminator.edge.block];
			case "branch":
				return [
					...exceptional,
					block.terminator.alternate.block,
					block.terminator.consequent.block,
				];
			case "guard":
				return [
					...exceptional,
					block.terminator.fallback.block,
					block.terminator.success.block,
				];
			case "switch":
				return [
					...exceptional,
					block.terminator.default.block,
					...block.terminator.cases.toReversed().map(({ edge }) => edge.block),
				];
			case "return":
			case "throw":
			case "unreachable":
				return exceptional;
		}
	};

	const visited = new Set<CoreBlockId>();
	const order: Array<CoreBlockId> = [];
	const visit = (start: CoreBlockId): void => {
		if (visited.has(start)) return;
		const postorder: Array<CoreBlockId> = [];
		visited.add(start);
		const stack: Array<{
			readonly block: CoreBlockId;
			readonly successors: ReadonlyArray<CoreBlockId>;
			index: number;
		}> = [{ block: start, successors: successors(core.blocks[start]!), index: 0 }];
		while (stack.length > 0) {
			const frame = stack.at(-1)!;
			if (frame.index >= frame.successors.length) {
				postorder.push(frame.block);
				stack.pop();
				continue;
			}
			const next = frame.successors[frame.index++]!;
			if (visited.has(next)) continue;
			visited.add(next);
			stack.push({
				block: next,
				successors: successors(core.blocks[next]!),
				index: 0,
			});
		}
		order.push(...postorder.toReversed());
	};
	visit(core.entry);
	for (const block of core.blocks) visit(block.id);
	return order;
}

interface LoweredCoreFunction {
	readonly fn: ExecutionFunction;
}

function lowerFunctionToTarget(
	core: CoreFunction,
	plannedDirectEntries: ReadonlyArray<PlannedDirectEntry>,
	directEntryByCall: ReadonlyMap<CoreInstruction, number>,
	instructionSites?: WeakMap<object, CompilerSiteFacts>,
	reuseRegisters = true,
): LoweredCoreFunction {
	const index = coreLoweringIndex(core);
	const loweredInstructions = new Map<CoreInstructionId, CompilerInstruction>();
	const protectedInstructions = coreRegionInstructionIds(core);
	const omittedInstructions = immediateOnlyInstructions(
		core,
		index,
		protectedInstructions,
	);
	const blockOrder = coreBlockLayout(core);
	const loweredBlockForCore = new Map<CoreBlockId, number>(
		blockOrder.map((block, index) => [block, index]),
	);
	const blocks: Array<{ instructions: Array<CompilerInstruction> }> = blockOrder.map(
		() => ({ instructions: [] }),
	);
	const {
		roots,
		registers: allocatedRegisters,
		registerRepresentations,
		safepoints: coreSafepoints,
	} = coreRegisterClasses(
		core,
		reuseRegisters,
		new Set(
			coreSupportsDirectEntries(core)
				? core.parameters.map((_parameter, index) => index)
				: [],
		),
	);
	const parallelCopies: Array<ExecutionParallelCopy> = [];
	const temporaryRegisters: Array<number> = [];
	const nextRegister = {
		value: Math.max(-1, ...allocatedRegisters.values()) + 1,
	};
	const allocatedRegisterCount = nextRegister.value;
	const registerForValue = (value: CoreValueId): number => {
		const root = roots.get(value)!;
		let register = allocatedRegisters.get(root);
		if (register === undefined) {
			register = nextRegister.value++;
			allocatedRegisters.set(root, register);
			registerRepresentations.set(register, core.values[root]!.representation);
		}
		return register;
	};

	const edgeBlock = (edge: CoreEdge): number => {
		const target = core.blocks[edge.block]!;
		const loweredTarget = loweredBlockForCore.get(edge.block);
		if (loweredTarget === undefined) {
			throw new Error(`Ordinary Core edge targets omitted block ${edge.block}`);
		}
		if (target.parameters[0]?.role === "exception") {
			throw new Error(`Ordinary Core edge targets exception block ${edge.block}`);
		}
		const assignments = target.parameters.map((parameter, index) => ({
			destination: registerForValue(parameter.value),
			source: registerForValue(edge.arguments[index]!),
		}));
		const copy = parallelMoves(assignments, nextRegister, registerRepresentations);
		if (copy.moves.length === 0) return loweredTarget;
		parallelCopies.push({ kind: "edge", assignments, ...copy });
		temporaryRegisters.push(...copy.temporaries);
		const index = blocks.length;
		blocks.push({
			instructions: [...copy.moves, { type: "jump", blocks: [loweredTarget] }],
		});
		return index;
	};
	const nextEmittedBlock = (block: CoreBlockId): number | undefined => {
		const lowered = loweredBlockForCore.get(block);
		return lowered === undefined || lowered + 1 >= blockOrder.length
			? undefined
			: lowered + 1;
	};

	const operationSafepoints: Array<
		Omit<Extract<ExecutionSafepoint, { kind: "operation" }>, "rootRegisters">
	> = [];
	const coreValueDefinitions = new Map(
		core.values.map(({ id, definition }) => [id, definition] as const),
	);
	for (const coreBlock of blockOrder) {
		const block = core.blocks[coreBlock]!;
		const loweredBlock = loweredBlockForCore.get(block.id)!;
		const instructions = blocks[loweredBlock]!.instructions;
		if (block.handler !== undefined) {
			const target = core.blocks[block.handler.block]!;
			const loweredHandler = loweredBlockForCore.get(block.handler.block);
			if (loweredHandler === undefined) {
				throw new Error(`Core handler targets omitted block ${block.handler.block}`);
			}
			const explicitParameters = target.parameters.slice(1);
			instructions.push({
				type: "tryBegin",
				blocks: [loweredHandler, loweredBlock],
			});
			const assignments = explicitParameters.map((parameter, index) => ({
				destination: registerForValue(parameter.value),
				source: registerForValue(block.handler!.arguments[index]!),
			}));
			const copy = parallelMoves(assignments, nextRegister, registerRepresentations);
			if (copy.moves.length > 0) {
				parallelCopies.push({ kind: "handler-input", assignments, ...copy });
				temporaryRegisters.push(...copy.temporaries);
			}
			instructions.push(...copy.moves);
		}
		if (block.parameters[0]?.role === "exception") {
			instructions.push({
				type: "catch",
				registers: [registerForValue(block.parameters[0].value)],
			});
		}
		for (const instruction of block.instructions) {
			if (omittedInstructions.has(instruction.id)) continue;
			instructions.push(...sourcePositionMarker(instruction.sourcePosition));
			const lowered = rebuildInstruction(
				index,
				instruction,
				registerForValue,
				protectedInstructions.has(instruction.id),
				core.isGenerator || core.isAsync,
			);
			const directEntryId = directEntryByCall.get(instruction);
			if (directEntryId !== undefined && lowered.type === "call") {
				lowered.directEntryId = directEntryId;
			}
			const compilerSite = instructionSites?.get(instruction);
			if (compilerSite !== undefined) instructionSites?.set(lowered, compilerSite);
			let resultMove: CompilerInstruction | undefined;
			const twoAddress = COMPILER_TWO_ADDRESS_OPERANDS[lowered.type];
			if (twoAddress !== undefined) {
				// Core models the reused operand as an ordinary SSA input, so allocation may
				// place it anywhere. A fresh register is required when the allocated result
				// and that operand differ: reusing the result register for the input can
				// clobber another live operand, such as the parent constructor.
				const registers = (lowered as { readonly registers: Array<number> }).registers;
				const destination = registers[twoAddress.result]!;
				const operand = registers[twoAddress.operand]!;
				for (const register of [destination, operand]) {
					if (physicalRegisterClass(registerRepresentations.get(register)!) !== "boxed") {
						throw new Error(
							`Two-address ${lowered.type} operand r${register} is not boxed`,
						);
					}
				}
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
					resultMove = {
						type: "move",
						registers: [destination, constrained],
					};
				} else {
					registers[twoAddress.operand] = destination;
				}
			}
			instructions.push(lowered);
			if (resultMove !== undefined) instructions.push(resultMove);
			loweredInstructions.set(instruction.id, lowered);
			const immediateValues = (
				lowered as { readonly immediateValues?: ReadonlyArray<unknown> }
			).immediateValues;
			const realizedCoreInstructions = new Set<CoreInstructionId>();
			if (coreSafepoints.has(instruction.id)) {
				realizedCoreInstructions.add(instruction.id);
			}
			for (const [index, input] of instruction.inputs.entries()) {
				if (immediateValues?.[instruction.outputs.length + index] === undefined) continue;
				const definition = coreValueDefinitions.get(input);
				if (
					definition?.kind === "instruction" &&
					coreSafepoints.has(definition.instruction)
				) {
					realizedCoreInstructions.add(definition.instruction);
				}
			}
			if (realizedCoreInstructions.size > 0) {
				operationSafepoints.push({
					kind: "operation",
					coreInstruction: instruction.id,
					realizedCoreInstructions: [...realizedCoreInstructions],
					instruction: lowered,
				});
			}
		}
		instructions.push(...sourcePositionMarker(block.terminator.sourcePosition));
		switch (block.terminator.kind) {
			case "jump":
				{
					const target = edgeBlock(block.terminator.edge);
					// Fallthrough encoding only: the omitted jump transfers control exactly
					// where the next emitted block starts, and a jump neither throws nor
					// ends the protected range that closes after it. Region certificates
					// name instructions, so a claimed terminator keeps its own encoding and
					// no region's shape can depend on where layout placed its successor.
					if (
						block.handler !== undefined &&
						!protectedInstructions.has(block.terminator.id) &&
						target === nextEmittedBlock(block.id)
					) {
						break;
					}
					const lowered: CompilerInstruction = {
						type: "jump",
						blocks: [target],
					};
					instructions.push(lowered);
					loweredInstructions.set(block.terminator.id, lowered);
				}
				break;
			case "branch":
				{
					const lowered: CompilerInstruction = {
						type: "jumpIf",
						registers: [registerForValue(block.terminator.condition)],
						blocks: [edgeBlock(block.terminator.consequent)],
					};
					const alternateJump: CompilerInstruction = {
						type: "jump",
						blocks: [edgeBlock(block.terminator.alternate)],
					};
					instructions.push(lowered, alternateJump);
					loweredInstructions.set(block.terminator.id, lowered);
				}
				break;
			case "guard":
				{
					const lowered: CompilerInstruction = {
						type: "jumpIf",
						registers: [registerForValue(block.terminator.condition)],
						blocks: [edgeBlock(block.terminator.success)],
					};
					const fallback: CompilerInstruction = {
						type: "jump",
						blocks: [edgeBlock(block.terminator.fallback)],
					};
					instructions.push(lowered, fallback);
					loweredInstructions.set(block.terminator.id, lowered);
				}
				break;
			case "return":
			case "throw":
				{
					const lowered: CompilerInstruction = {
						type: block.terminator.kind,
						registers: [registerForValue(block.terminator.value)],
					};
					instructions.push(lowered);
					loweredInstructions.set(block.terminator.id, lowered);
				}
				break;
			case "switch":
				for (const switchCase of block.terminator.cases) {
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
							registers: [
								matches,
								registerForValue(block.terminator.discriminant),
								immediate,
							],
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
					blocks: [edgeBlock(block.terminator.default)],
				});
				break;
			case "unreachable":
				throw new Error(`Reachable Core block ${block.id} ends in unreachable`);
		}
		if (block.handler !== undefined) instructions.push({ type: "tryEnd" });
	}

	const physicalRepresentations = Array.from(
		{ length: nextRegister.value },
		(_, register): ExecutionRegisterRepresentation => {
			const representation = registerRepresentations.get(register);
			if (representation === undefined) {
				throw new Error(`Core allocation left r${register} without a representation`);
			}
			// Resumable native frames persist every register in a MalValue array; the
			// execution contract must expose that physical representation so liveness
			// cannot omit a scalar that the collector may clear before suspension.
			return core.isGenerator || core.isAsync
				? "boxed"
				: physicalRegisterClass(representation);
		},
	);
	const fnWithoutGc: Omit<ExecutionFunction, "gc" | "directEntries"> = {
		sourcePath: core.metadata.sourcePath,
		functionIndex: core.functionIndex,
		nameStringIndex: core.metadata.nameStringIndex,
		blocks,
		specializations: lowerCoreRegions(
			core.regions,
			loweredInstructions,
			loweredBlockForCore,
			new Map(core.values.map(({ id }) => [id, registerForValue(id)])),
		),
		isGenerator: core.isGenerator,
		isAsync: core.isAsync,
		parameterCount: core.parameters.length,
		mappedArgumentSlots: [...core.metadata.mappedArgumentSlots],
		mappedArguments: core.metadata.mappedArguments,
		length: core.metadata.length,
		registerCount: nextRegister.value,
		allocatedRegisterCount,
		registerRepresentations: physicalRepresentations,
		capturedCount: core.metadata.capturedCount,
		strict: core.metadata.strict,
		isClassConstructor: core.metadata.isClassConstructor,
		isDerivedConstructor: core.metadata.isDerivedConstructor,
		hasPrototype: core.metadata.hasPrototype,
		parallelCopies,
		temporaryRegisters,
	};
	const analysisFunction: ExecutionFunction = {
		...fnWithoutGc,
		directEntries: [],
		gc: { safepoints: [] },
	};
	const backedges = executionLoopBackedgeInstructions(analysisFunction);
	type PendingSafepoint =
		| Omit<Extract<ExecutionSafepoint, { kind: "operation" }>, "rootRegisters">
		| Omit<Extract<ExecutionSafepoint, { kind: "loop-backedge" }>, "rootRegisters">;
	const pendingSafepoints: Array<PendingSafepoint> = [
		...operationSafepoints,
		...[...backedges].map((instruction) => ({
			kind: "loop-backedge" as const,
			instruction,
		})),
	];
	const rootsAtSafepoint = executionSafepointRootRegisters(
		analysisFunction,
		new Set(pendingSafepoints.map(({ instruction }) => instruction)),
	);
	const instructionOrder = new Map<CompilerInstruction, number>();
	let nextInstructionOrder = 0;
	for (const { instructions } of blocks) {
		for (const instruction of instructions) {
			instructionOrder.set(instruction, nextInstructionOrder++);
		}
	}
	const safepoints: Array<ExecutionSafepoint> = pendingSafepoints
		.map((safepoint) => ({
			...safepoint,
			rootRegisters: rootsAtSafepoint.get(safepoint.instruction) ?? [],
		}))
		.sort(
			(left, right) =>
				instructionOrder.get(left.instruction)! -
				instructionOrder.get(right.instruction)!,
		);
	const directEntries: Array<ExecutionDirectEntry> = plannedDirectEntries.map((entry) => {
		const registerRepresentations = [...physicalRepresentations];
		for (const [parameter, representation] of entry.parameterRepresentations.entries()) {
			registerRepresentations[parameter] = representation;
		}
		return {
			...entry,
			registerRepresentations,
			gc: {
				safepoints: safepoints.map((safepoint) => ({
					...safepoint,
					// Direct entries only specialize boxed ABI parameters. Register
					// liveness is independent per physical register, so the exact roots
					// are the ordinary roots with newly-unboxed parameters removed; a
					// second whole-function dataflow solve cannot discover another root.
					rootRegisters: safepoint.rootRegisters.filter((register) => {
						const representation = registerRepresentations[register];
						return representation === "boxed" || representation === "string";
					}),
				})),
			},
		};
	});
	return {
		fn: {
			...fnWithoutGc,
			directEntries,
			gc: { safepoints },
		},
	};
}

/** Select and allocate canonical Core into the VM target form. */
export interface LowerCoreToExecutionOptions {
	readonly reuseRegisters?: boolean;
}

export function lowerCoreCompilationWithDirectEntries(
	compilation: CoreCompilation,
	directEntries: DirectEntryPlan,
	options: LowerCoreToExecutionOptions,
): ExecutionProgram {
	const { program: core, context } = compilation;
	const lowered = core.functions.map((fn) =>
		lowerFunctionToTarget(
			fn,
			directEntries.entriesByFunction[fn.functionIndex]!,
			directEntries.entryByCall,
			context.facts.instructionSites,
			options.reuseRegisters ?? true,
		),
	);
	const program: ExecutionProgram = {
		core,
		context,
		functions: lowered.map(({ fn }) => fn),
	};
	return program;
}

/**
 * Select and allocate the bytecode/runtime contract without native-only ABI variants.
 * Runtime eval serializes no NativePlan, so planning those entries would retain dead
 * compiler machinery. Canonical allocation still preserves eligible ABI parameter
 * colors so a native overlay cannot perturb the portable image.
 */
export function lowerCoreCompilationToRuntimeExecution(
	compilation: CoreCompilation,
	options: LowerCoreToExecutionOptions = {},
): ExecutionProgram {
	const { program: core, context } = compilation;
	verifyCoreProgram(
		core,
		coreOpcodeRegistry,
		{ stage: "pre-target" },
		context,
		compilation.targetAnalyses,
	);
	const program = lowerCoreCompilationWithDirectEntries(
		compilation,
		{
			entriesByFunction: core.functions.map(() => []),
			entryByCall: new Map(),
		},
		options,
	);
	// Owned boundary: no runtime-image consumer may observe an unverified target program.
	verifyExecutionProgram(program);
	return program;
}
