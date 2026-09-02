import {
	COMPILER_VALUE_KIND_BIGINT,
	COMPILER_VALUE_KIND_BOOLEAN,
	COMPILER_VALUE_KIND_NULL,
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_NUMBER_OR_UNDEFINED,
	COMPILER_VALUE_KIND_OBJECT,
	COMPILER_VALUE_KIND_STRING,
	COMPILER_VALUE_KIND_SYMBOL,
	COMPILER_VALUE_KIND_TOP,
	COMPILER_VALUE_KIND_UNDEFINED,
	compilerValueKindMaskIsSubset,
	compilerValueKindMaskIsValid,
} from "../shared/compiler-value-kinds.ts";
import type { CompilerValueKindMask } from "../shared/compiler-value-kinds.ts";
import type { CoreAnalysisDefinition } from "./core-analysis-manager.ts";
import { CORE_ANY_SCRIPT_AGGREGATE } from "./core-call-graph.ts";
import type { CoreCallGraphNode } from "./core-call-graph.ts";
import type { CoreCallGraphIndex } from "./core-ir-call-targets.ts";
import { CORE_EXCEPTIONAL_CONTROL_FLOW_ANALYSIS } from "./core-ir-control-flow.ts";
import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import type {
	CoreFunctionId,
	CoreBlockId,
	CoreInstructionEffects,
	CoreInstructionId,
	CoreValueId,
} from "./core-ir.ts";
import { coreInstructionId } from "./core-ir.ts";
import { CORE_PROGRAM_FLOW_RETURN_KIND } from "./core-program-flow.ts";
import type {
	CoreProgramFlowSccSolver,
	CoreProgramFlowTopology,
} from "./core-program-flow.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

export const CORE_EXACT_CALL_ARGUMENT_REPRESENTATIONS_ATTRIBUTE =
	"exactCallArgumentRepresentations";
export const CORE_EXACT_BINARY_INPUT_KIND_MASKS_ATTRIBUTE = "exactBinaryInputKindMasks";
export const CORE_EXACT_SCALAR_AFTER_TDZ_ATTRIBUTE = "exactScalarAfterTdz";
export const CORE_PRIMITIVE_OPERATOR_EFFECT_FACT = "primitive-operator-effects";

export type CoreExactScalarKind = "int32" | "number" | "boolean" | "string";
export type CoreExactCallArgumentRepresentation = "boxed" | CoreExactScalarKind;

export interface CoreValueKindAnalysis {
	kindMask(value: CoreValueId): CompilerValueKindMask;
	latticeMask(value: CoreValueId): CompilerValueKindMask;
	exactScalar(value: CoreValueId): CoreExactScalarKind | undefined;
}

export interface CoreValueKindInputs {
	readonly parameterMasks?: ReadonlyArray<CompilerValueKindMask>;
	readonly receiverMask?: CompilerValueKindMask;
	readonly operationResultMask?: (
		instruction: CoreInstructionId,
		result: CoreValueId,
	) => CompilerValueKindMask | undefined;
}

const NUMERIC_UNARY_OPERATORS: ReadonlySet<string> = new Set([
	"-",
	"+",
	"~",
	"increment",
	"decrement",
	"tonumeric",
]);
const NON_COERCING_UNARY_OPERATORS: ReadonlySet<string> = new Set([
	"!",
	"typeof",
	"void",
]);
const NUMERIC_BINARY_OPERATORS: ReadonlySet<string> = new Set([
	"+",
	"-",
	"*",
	"/",
	"%",
	"**",
	"&",
	"|",
	"^",
	"<<",
	">>",
	">>>",
]);
const COMPARISON_OPERATORS: ReadonlySet<string> = new Set([
	"<",
	"<=",
	">",
	">=",
	"==",
	"!=",
	"===",
	"!==",
]);

function numberIsExactInt32(value: unknown): boolean {
	return (
		typeof value === "number" &&
		Number.isInteger(value) &&
		value >= -0x8000_0000 &&
		value <= 0x7fff_ffff &&
		!Object.is(value, -0)
	);
}

function representationKind(
	fn: CoreFunctionStore,
	value: CoreValueId,
): CompilerValueKindMask | undefined {
	switch (fn.valueRepresentation(value)) {
		case "f64":
		case "i32":
			return COMPILER_VALUE_KIND_NUMBER;
		case "boolean":
			return COMPILER_VALUE_KIND_BOOLEAN;
		case "string":
		case "string-span":
			return COMPILER_VALUE_KIND_STRING;
		case "projected-elements":
		case "dense-elements":
		case "scalarized-object":
			return COMPILER_VALUE_KIND_OBJECT;
		case "boxed":
			return undefined;
	}
}

function staticOpcodeKind(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): CompilerValueKindMask | undefined {
	switch (fn.instructionOpcodeName(instruction)) {
		case "createUndefined":
			return COMPILER_VALUE_KIND_UNDEFINED;
		case "createNull":
			return COMPILER_VALUE_KIND_NULL;
		case "createBoolean":
			return COMPILER_VALUE_KIND_BOOLEAN;
		case "createF64":
		case "createNumber":
			return COMPILER_VALUE_KIND_NUMBER;
		case "createString":
			return COMPILER_VALUE_KIND_STRING;
		case "createBigint":
			return COMPILER_VALUE_KIND_BIGINT;
		case "createPrivateName":
		case "createPrivateNames":
			return COMPILER_VALUE_KIND_SYMBOL;
		case "createFunction":
		case "createArray":
		case "createObject":
		case "createObjectShaped":
		case "createModuleNamespace":
		case "createTemplateObject":
		case "instantiateLiteralTemplate":
			return COMPILER_VALUE_KIND_OBJECT;
		case "isEmpty":
		case "typeofCompare":
			return COMPILER_VALUE_KIND_BOOLEAN;
		default:
			return undefined;
	}
}

const KIND_TRANSFER_CONSTANT = 0;
const KIND_TRANSFER_JOIN = 1;
const KIND_TRANSFER_COPY = 2;
const KIND_TRANSFER_NUMERIC_UNARY = 3;
const KIND_TRANSFER_BINARY = 4;
const KIND_TRANSFER_ADD = 5;

interface KindTransferBuffer {
	readonly kinds: Array<number>;
	readonly outputs: Array<CoreValueId>;
	readonly constants: Array<CompilerValueKindMask>;
	readonly inputStarts: Array<number>;
	readonly inputCounts: Array<number>;
	readonly inputs: Array<CoreValueId>;
}

function addKindTransfer(
	buffer: KindTransferBuffer,
	kind: number,
	output: CoreValueId,
	constant: CompilerValueKindMask,
	inputs: ReadonlyArray<CoreValueId> = [],
): void {
	buffer.kinds.push(kind);
	buffer.outputs.push(output);
	buffer.constants.push(constant);
	buffer.inputStarts.push(buffer.inputs.length);
	buffer.inputCounts.push(inputs.length);
	for (const input of inputs) buffer.inputs.push(input);
}

function addOperationTransfer(
	buffer: KindTransferBuffer,
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	output: CoreValueId,
	inputs?: CoreValueKindInputs,
): void {
	const operandStart = fn.kernel.instructionOperandStart(instruction);
	const operandCount = fn.kernel.instructionOperandCount(instruction);
	const operands = Array.from({ length: operandCount }, (_, index) =>
		fn.kernel.operandAt(operandStart + index),
	);
	const staticKind = representationKind(fn, output) ?? staticOpcodeKind(fn, instruction);
	if (staticKind !== undefined) {
		addKindTransfer(buffer, KIND_TRANSFER_CONSTANT, output, staticKind);
		return;
	}
	const opcode = fn.instructionOpcodeName(instruction);
	if (opcode === "loadThis" && inputs?.receiverMask !== undefined) {
		addKindTransfer(buffer, KIND_TRANSFER_CONSTANT, output, inputs.receiverMask);
		return;
	}
	const supplied = inputs?.operationResultMask?.(instruction, output);
	if (supplied !== undefined) {
		addKindTransfer(buffer, KIND_TRANSFER_CONSTANT, output, supplied);
		return;
	}
	const operator = fn.instructionAttributes(instruction).operator;
	if (opcode === "move" && operands.length === 1) {
		addKindTransfer(buffer, KIND_TRANSFER_COPY, output, 0, operands);
		return;
	}
	if (opcode === "unary" && operands.length === 1 && typeof operator === "string") {
		const constant =
			operator === "!"
				? COMPILER_VALUE_KIND_BOOLEAN
				: operator === "typeof"
					? COMPILER_VALUE_KIND_STRING
					: operator === "void"
						? COMPILER_VALUE_KIND_UNDEFINED
						: undefined;
		if (constant !== undefined) {
			addKindTransfer(buffer, KIND_TRANSFER_CONSTANT, output, constant);
		} else if (NUMERIC_UNARY_OPERATORS.has(operator)) {
			addKindTransfer(buffer, KIND_TRANSFER_NUMERIC_UNARY, output, 0, operands);
		} else {
			addKindTransfer(buffer, KIND_TRANSFER_CONSTANT, output, COMPILER_VALUE_KIND_TOP);
		}
		return;
	}
	if (opcode === "binary" && operands.length === 2 && typeof operator === "string") {
		if (COMPARISON_OPERATORS.has(operator)) {
			addKindTransfer(
				buffer,
				KIND_TRANSFER_CONSTANT,
				output,
				COMPILER_VALUE_KIND_BOOLEAN,
			);
		} else if (operator === "+") {
			addKindTransfer(buffer, KIND_TRANSFER_ADD, output, 0, operands);
		} else if (NUMERIC_BINARY_OPERATORS.has(operator)) {
			addKindTransfer(buffer, KIND_TRANSFER_BINARY, output, 0, operands);
		} else {
			addKindTransfer(buffer, KIND_TRANSFER_CONSTANT, output, COMPILER_VALUE_KIND_TOP);
		}
		return;
	}
	addKindTransfer(buffer, KIND_TRANSFER_CONSTANT, output, COMPILER_VALUE_KIND_TOP);
}

export function analyzeCoreValueKinds(
	fn: CoreFunctionStore,
	cfg: CoreControlFlow,
	inputs?: CoreValueKindInputs,
): CoreValueKindAnalysis {
	const transfers: KindTransferBuffer = {
		kinds: [],
		outputs: [],
		constants: [],
		inputStarts: [],
		inputCounts: [],
		inputs: [],
	};
	const formalParameters = new Int32Array(fn.valueCapacity);
	formalParameters.fill(-1);
	for (let index = 0; index < fn.parameterCount; index++) {
		formalParameters[fn.kernel.functionParameter(index)] = index;
	}
	for (let blockIndex = 0; blockIndex < fn.blockCapacity; blockIndex++) {
		const block = blockIndex as CoreBlockId;
		if (fn.kernel.blockLive(block) === 0) continue;
		const incoming = cfg.predecessors[block] ?? [];
		const parameterStart = fn.kernel.blockParameterStart(block);
		const parameterCount = fn.kernel.blockParameterCount(block);
		for (let index = 0; index < parameterCount; index++) {
			const row = parameterStart + index;
			const parameter = fn.kernel.blockParameterValue(row);
			const representation = representationKind(fn, parameter);
			const formalIndex = formalParameters[parameter]!;
			if (
				representation !== undefined ||
				formalIndex >= 0 ||
				fn.kernel.blockParameterRole(row) === 1 ||
				incoming.length === 0
			) {
				const kind =
					representation ??
					(formalIndex < 0
						? COMPILER_VALUE_KIND_TOP
						: (inputs?.parameterMasks?.[formalIndex] ?? COMPILER_VALUE_KIND_TOP));
				addKindTransfer(transfers, KIND_TRANSFER_CONSTANT, parameter, kind);
				continue;
			}
			const incomingValues: Array<CoreValueId> = [];
			for (const edge of incoming) {
				const value = edge.arguments[edge.kind === "exceptional" ? index - 1 : index];
				if (value !== undefined) incomingValues.push(value);
			}
			addKindTransfer(transfers, KIND_TRANSFER_JOIN, parameter, 0, incomingValues);
		}
		for (
			let instructionIndex = fn.kernel.blockFirstInstruction(block);
			instructionIndex >= 0;
			instructionIndex = fn.kernel.instructionNext(instructionIndex as CoreInstructionId)
		) {
			const instruction = instructionIndex as CoreInstructionId;
			if (fn.kernel.instructionOpcode(instruction) < 0) continue;
			const resultStart = fn.kernel.instructionResultStart(instruction);
			const resultCount = fn.kernel.instructionResultCount(instruction);
			for (let index = 0; index < resultCount; index++) {
				const output = fn.kernel.resultAt(resultStart + index);
				addOperationTransfer(transfers, fn, instruction, output, inputs);
			}
		}
	}
	const dependentHeads = new Int32Array(fn.valueCapacity);
	dependentHeads.fill(-1);
	const dependentTransfers = new Uint32Array(transfers.inputs.length);
	const dependentNext = new Int32Array(transfers.inputs.length);
	let dependentCount = 0;
	for (let index = 0; index < transfers.outputs.length; index++) {
		const inputStart = transfers.inputStarts[index]!;
		const inputCount = transfers.inputCounts[index]!;
		for (let offset = 0; offset < inputCount; offset++) {
			const input = transfers.inputs[inputStart + offset]!;
			dependentTransfers[dependentCount] = index;
			dependentNext[dependentCount] = dependentHeads[input]!;
			dependentHeads[input] = dependentCount++;
		}
	}
	const transferKinds = Uint8Array.from(transfers.kinds);
	const transferOutputs = Uint32Array.from(transfers.outputs);
	const transferConstants = Uint16Array.from(transfers.constants);
	const transferInputStarts = Uint32Array.from(transfers.inputStarts);
	const transferInputCounts = Uint32Array.from(transfers.inputCounts);
	const transferInputs = Uint32Array.from(transfers.inputs);
	const masks = new Uint16Array(fn.valueCapacity);
	const mask = (value: CoreValueId): number => masks[value] ?? 0;
	const wakeDependents = (
		value: CoreValueId,
		queued: Uint8Array,
		queue: Array<number>,
	): void => {
		for (let dependency = dependentHeads[value]!; dependency >= 0; ) {
			const transfer = dependentTransfers[dependency]!;
			dependency = dependentNext[dependency]!;
			if (queued[transfer] !== 0) continue;
			queued[transfer] = 1;
			queue.push(transfer);
		}
	};
	const queue = Array.from({ length: transferOutputs.length }, (_, index) => index);
	const queued = new Uint8Array(transferOutputs.length);
	queued.fill(1);
	let cursor = 0;
	while (cursor < queue.length) {
		const index = queue[cursor++]!;
		queued[index] = 0;
		const kind = transferKinds[index]!;
		const inputStart = transferInputStarts[index]!;
		const inputCount = transferInputCounts[index]!;
		let incoming = transferConstants[index]!;
		if (kind === KIND_TRANSFER_JOIN) {
			for (let offset = 0; offset < inputCount; offset++) {
				incoming |= mask(transferInputs[inputStart + offset]! as CoreValueId);
			}
		} else if (kind === KIND_TRANSFER_COPY) {
			incoming = mask(transferInputs[inputStart]! as CoreValueId);
		} else if (kind === KIND_TRANSFER_NUMERIC_UNARY) {
			incoming = compilerValueKindMaskIsSubset(
				mask(transferInputs[inputStart]! as CoreValueId),
				COMPILER_VALUE_KIND_NUMBER,
			)
				? COMPILER_VALUE_KIND_NUMBER
				: COMPILER_VALUE_KIND_TOP;
		} else if (kind === KIND_TRANSFER_BINARY || kind === KIND_TRANSFER_ADD) {
			const left = mask(transferInputs[inputStart]! as CoreValueId);
			const right = mask(transferInputs[inputStart + 1]! as CoreValueId);
			if (left === 0 || right === 0) incoming = 0;
			else if (
				kind === KIND_TRANSFER_ADD &&
				compilerValueKindMaskIsSubset(left, COMPILER_VALUE_KIND_STRING) &&
				compilerValueKindMaskIsSubset(right, COMPILER_VALUE_KIND_STRING)
			) {
				incoming = COMPILER_VALUE_KIND_STRING;
			} else {
				incoming =
					compilerValueKindMaskIsSubset(left, COMPILER_VALUE_KIND_NUMBER) &&
					compilerValueKindMaskIsSubset(right, COMPILER_VALUE_KIND_NUMBER)
						? COMPILER_VALUE_KIND_NUMBER
						: COMPILER_VALUE_KIND_TOP;
			}
		}
		const output = transferOutputs[index]! as CoreValueId;
		const next = masks[output]! | incoming;
		if (next === masks[output]) continue;
		masks[output] = next;
		wakeDependents(output, queued, queue);
	}
	const exactInt32 = new Uint8Array(fn.valueCapacity);
	for (let valueIndex = 0; valueIndex < fn.valueCapacity; valueIndex++) {
		const value = valueIndex as CoreValueId;
		if (fn.kernel.valueLive(value) === 0) continue;
		if (fn.valueRepresentation(value) === "i32") exactInt32[value] = 1;
		if (fn.kernel.valueDefinitionKind(value) !== 1) continue;
		const definition = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
		if (fn.instructionKind(definition) !== "operation") continue;
		const opcode = fn.instructionOpcodeName(definition);
		if (
			(opcode === "createNumber" || opcode === "createF64") &&
			numberIsExactInt32(fn.instructionAttributes(definition).value)
		)
			exactInt32[value] = 1;
	}
	const exactQueue = Array.from({ length: transferOutputs.length }, (_, index) => index);
	const exactQueued = new Uint8Array(transferOutputs.length);
	exactQueued.fill(1);
	let exactCursor = 0;
	while (exactCursor < exactQueue.length) {
		const index = exactQueue[exactCursor++]!;
		exactQueued[index] = 0;
		const output = transferOutputs[index]! as CoreValueId;
		const inputStart = transferInputStarts[index]!;
		const inputCount = transferInputCounts[index]!;
		let allInputsExact = inputCount > 0;
		for (let offset = 0; offset < inputCount; offset++) {
			const input = transferInputs[inputStart + offset]! as CoreValueId;
			if (exactInt32[input] !== 0) continue;
			allInputsExact = false;
			break;
		}
		if (
			exactInt32[output] !== 0 ||
			masks[output] !== COMPILER_VALUE_KIND_NUMBER ||
			!allInputsExact
		)
			continue;
		const definitionKind = fn.kernel.valueDefinitionKind(output);
		const forwardsInteger =
			definitionKind === 0 ||
			(definitionKind === 1 &&
				fn.instructionOpcodeName(
					coreInstructionId(fn.kernel.valueDefinitionOwner(output)),
				) === "move");
		if (!forwardsInteger) continue;
		exactInt32[output] = 1;
		wakeDependents(output, exactQueued, exactQueue);
	}
	const result: CoreValueKindAnalysis = {
		kindMask(value) {
			const valueMask = mask(value);
			return valueMask === 0 ? COMPILER_VALUE_KIND_TOP : valueMask;
		},
		latticeMask(value) {
			return mask(value);
		},
		exactScalar(value) {
			const valueMask = mask(value) || COMPILER_VALUE_KIND_TOP;
			if (valueMask === COMPILER_VALUE_KIND_NUMBER) {
				return exactInt32[value] === 1 ? "int32" : "number";
			}
			if (valueMask === COMPILER_VALUE_KIND_BOOLEAN) return "boolean";
			if (valueMask === COMPILER_VALUE_KIND_STRING) return "string";
			return undefined;
		},
	};
	return Object.freeze(result);
}

export const CORE_LOCAL_VALUE_KIND_ANALYSIS: CoreAnalysisDefinition<CoreValueKindAnalysis> =
	{
		key: "local-value-kinds",
		scope: "function",
		functionDependencies: ["body", "cfg", "representations"],
		contextIdentity: (context) => context.data.singleAssignmentGlobalSlots.join(","),
		compute({ program, context, request, get }) {
			if (request.scope !== "function") throw new Error("Expected function analysis");
			const fn = program.function(request.function);
			const cfg = get(CORE_EXCEPTIONAL_CONTROL_FLOW_ANALYSIS, request);
			const closedGlobals = new Set(context.data.singleAssignmentGlobalSlots);
			const stores = new Map<
				number,
				{
					readonly instruction: CoreInstructionId;
					readonly value: CoreValueId;
				} | null
			>();
			const emptyInitialization = (value: CoreValueId): boolean => {
				if (fn.kernel.valueDefinitionKind(value) !== 1) return false;
				const definition = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
				const opcode = fn.instructionOpcodeName(definition);
				if (opcode === "createEmpty") return true;
				const source =
					fn.kernel.instructionOperandCount(definition) === 0
						? undefined
						: fn.kernel.operandAt(fn.kernel.instructionOperandStart(definition));
				return opcode === "move" && source !== undefined && emptyInitialization(source);
			};
			const storeGlobalOpcode = fn.registry.get("storeGlobal")?.id;
			for (
				let instructionIndex = 0;
				storeGlobalOpcode !== undefined && instructionIndex < fn.instructionCapacity;
				instructionIndex++
			) {
				const instruction = instructionIndex as CoreInstructionId;
				if (
					fn.kernel.instructionLive(instruction) === 0 ||
					fn.kernel.instructionOpcode(instruction) !== storeGlobalOpcode
				)
					continue;
				const index = fn.instructionAttributes(instruction).index;
				const value =
					fn.kernel.instructionOperandCount(instruction) === 0
						? undefined
						: fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction));
				if (
					typeof index !== "number" ||
					value === undefined ||
					!closedGlobals.has(index) ||
					emptyInitialization(value)
				)
					continue;
				stores.set(index, stores.has(index) ? null : { instruction, value });
			}
			const instructionOrder = new Int32Array(fn.instructionCapacity);
			instructionOrder.fill(-1);
			for (let blockIndex = 0; blockIndex < fn.blockCapacity; blockIndex++) {
				const block = blockIndex as CoreBlockId;
				if (fn.kernel.blockLive(block) === 0) continue;
				let order = 0;
				for (
					let instructionIndex = fn.kernel.blockFirstInstruction(block);
					instructionIndex >= 0;
					instructionIndex = fn.kernel.instructionNext(
						instructionIndex as CoreInstructionId,
					)
				) {
					instructionOrder[instructionIndex] = order++;
				}
			}
			const storedKind = (value: CoreValueId): CompilerValueKindMask | undefined => {
				const representation = representationKind(fn, value);
				if (representation !== undefined) return representation;
				if (fn.kernel.valueDefinitionKind(value) !== 1) return undefined;
				const definition = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
				const kind = staticOpcodeKind(fn, definition);
				if (kind !== undefined) return kind;
				const source =
					fn.kernel.instructionOperandCount(definition) === 0
						? undefined
						: fn.kernel.operandAt(fn.kernel.instructionOperandStart(definition));
				return fn.instructionOpcodeName(definition) === "move" && source !== undefined
					? storedKind(source)
					: undefined;
			};
			const operationResultMask = (
				instruction: CoreInstructionId,
			): CompilerValueKindMask | undefined => {
				if (fn.instructionOpcodeName(instruction) !== "loadGlobal") return undefined;
				const index = fn.instructionAttributes(instruction).index;
				if (typeof index !== "number") return undefined;
				const store = stores.get(index);
				if (store === undefined || store === null) return undefined;
				const storeBlock = fn.instructionBlock(store.instruction);
				const loadBlock = fn.instructionBlock(instruction);
				const dominates =
					storeBlock === loadBlock
						? instructionOrder[store.instruction]! < instructionOrder[instruction]!
						: cfg.instructionDominatesBlock(storeBlock, loadBlock);
				return dominates ? storedKind(store.value) : undefined;
			};
			return analyzeCoreValueKinds(
				fn,
				cfg,
				closedGlobals.size === 0 ? undefined : { operationResultMask },
			);
		},
	};

export interface CoreProgramValueKindSummary {
	readonly parameterKinds: ReadonlyArray<CompilerValueKindMask>;
	readonly receiverKind: CompilerValueKindMask;
	readonly returnKind: CompilerValueKindMask;
}

export interface CoreProgramValueKindStatistics {
	readonly functions: number;
	readonly functionsEvaluated: number;
	readonly functionsReused: number;
	readonly affectedFunctions: number;
	readonly callerWakeups: number;
	readonly calleeWakeups: number;
	readonly aggregateRecomputations: number;
	readonly exactReverseCallerVisits: number;
	readonly wildcardReverseCallerVisits: number;
	readonly aggregateFunctionVisits: number;
}

export interface CoreProgramValueKinds {
	readonly changedFunctions: ReadonlySet<CoreFunctionId>;
	readonly statistics: CoreProgramValueKindStatistics;
	values(functionId: CoreFunctionId): CoreValueKindAnalysis;
	summary(functionId: CoreFunctionId): CoreProgramValueKindSummary;
}

interface CoreProgramValueKindState extends CoreProgramValueKinds {
	readonly sourceClosed: boolean;
	readonly targets: CoreCallGraphIndex;
	readonly external: ReadonlyMap<CoreFunctionId, boolean>;
	readonly valueAnalyses: ReadonlyMap<CoreFunctionId, CoreValueKindAnalysis>;
	readonly summaries: ReadonlyMap<CoreFunctionId, CoreProgramValueKindSummary>;
	readonly wildcardContributions: ReadonlyMap<
		CoreFunctionId,
		CoreProgramValueKindWildcardContribution
	>;
	readonly anyScriptAggregate: CoreProgramValueKindAggregate | undefined;
}

interface CoreProgramValueKindWildcardContribution {
	readonly parameterKinds: ReadonlyArray<CompilerValueKindMask>;
	readonly strictReceiverKind: CompilerValueKindMask;
}

interface CoreProgramValueKindAggregate extends CoreProgramValueKindWildcardContribution {
	readonly returnKind: CompilerValueKindMask;
}

function freezeProgramValueKindSummary(
	summary: CoreProgramValueKindSummary,
): CoreProgramValueKindSummary {
	return Object.freeze({
		parameterKinds: Object.freeze([...summary.parameterKinds]),
		receiverKind: summary.receiverKind,
		returnKind: summary.returnKind,
	});
}

function sameMasks(
	left: ReadonlyArray<CompilerValueKindMask>,
	right: ReadonlyArray<CompilerValueKindMask>,
): boolean {
	return (
		left.length === right.length && left.every((value, index) => value === right[index])
	);
}

function sameWildcardContribution(
	left: CoreProgramValueKindWildcardContribution | undefined,
	right: CoreProgramValueKindWildcardContribution | undefined,
): boolean {
	return (
		left !== undefined &&
		right !== undefined &&
		left.strictReceiverKind === right.strictReceiverKind &&
		sameMasks(left.parameterKinds, right.parameterKinds)
	);
}

export function solveCoreProgramValueKinds(
	program: CoreProgram,
	targets: CoreCallGraphIndex,
	externallyReachable: (functionId: CoreFunctionId) => boolean,
	controlFlow: (functionId: CoreFunctionId) => CoreControlFlow,
	topology: CoreProgramFlowTopology,
	scheduler: CoreProgramFlowSccSolver,
	previous?: CoreProgramValueKindState,
	dirtyFunctions?: ReadonlyArray<CoreFunctionId>,
	externallyChangedFunctions?: ReadonlySet<CoreFunctionId>,
): CoreProgramValueKindState {
	const functionIds = [...program.functionIds()];
	const maximumParameterCount = functionIds.reduce(
		(largest, functionId) =>
			Math.max(largest, program.function(functionId).parameterCount),
		0,
	);
	const live = new Set(functionIds);
	const external = new Map(
		functionIds.map((functionId) => [functionId, externallyReachable(functionId)]),
	);
	const affected = new Set<CoreFunctionId>();
	let aggregateInitiallyAffected = false;
	if (previous === undefined || previous.sourceClosed !== targets.sourceClosed) {
		for (const functionId of functionIds) affected.add(functionId);
		aggregateInitiallyAffected = targets.graph.hasAggregate();
	} else {
		for (const functionId of dirtyFunctions ?? functionIds) affected.add(functionId);
		for (const functionId of targets.changedCallers) affected.add(functionId);
		for (const functionId of externallyChangedFunctions ?? functionIds) {
			if (previous.external.get(functionId) !== external.get(functionId)) {
				affected.add(functionId);
			}
		}
		aggregateInitiallyAffected = targets.graph.changedNodes.has(
			CORE_ANY_SCRIPT_AGGREGATE,
		);
		if (previous.targets.graph.hasAggregate() && !targets.graph.hasAggregate()) {
			for (const functionId of functionIds) affected.add(functionId);
		}
	}
	let anyScriptAggregate = targets.graph.hasAggregate()
		? previous?.anyScriptAggregate
		: undefined;
	const seededSummary = (
		functionId: CoreFunctionId,
		aggregate: CoreProgramValueKindAggregate | undefined,
	): CoreProgramValueKindSummary => {
		const fn = program.function(functionId);
		const seed = external.get(functionId) === true ? COMPILER_VALUE_KIND_TOP : 0;
		return {
			parameterKinds: Array.from(
				{ length: fn.parameterCount },
				(_, index) => seed | (aggregate?.parameterKinds[index] ?? 0),
			),
			receiverKind:
				seed |
				(aggregate === undefined
					? 0
					: fn.metadata.strict
						? aggregate.strictReceiverKind
						: COMPILER_VALUE_KIND_OBJECT),
			returnKind: 0,
		};
	};
	const summaries = new Map<CoreFunctionId, CoreProgramValueKindSummary>();
	const valueAnalyses = new Map<CoreFunctionId, CoreValueKindAnalysis>();
	for (const functionId of functionIds) {
		if (!affected.has(functionId)) {
			const summary = previous?.summaries.get(functionId);
			const analysis = previous?.valueAnalyses.get(functionId);
			if (summary !== undefined && analysis !== undefined) {
				summaries.set(functionId, summary);
				valueAnalyses.set(functionId, analysis);
				continue;
			}
			affected.add(functionId);
		}
		summaries.set(functionId, seededSummary(functionId, anyScriptAggregate));
	}
	const wildcardContributions = new Map<
		CoreFunctionId,
		CoreProgramValueKindWildcardContribution
	>();
	for (const [functionId, contribution] of previous?.wildcardContributions ?? []) {
		if (live.has(functionId)) {
			wildcardContributions.set(functionId, contribution);
		}
	}
	let callerWakeups = 0;
	let calleeWakeups = 0;
	let functionsEvaluated = 0;
	let aggregateRecomputations = 0;
	let exactReverseCallerVisits = 0;
	let wildcardReverseCallerVisits = 0;
	let aggregateFunctionVisits = 0;
	const activeSccs = new Set<number>();
	const initialSccs = new Set<number>();
	const pendingFunctionSccs = new Set<number>();
	const pendingAggregateSccs = new Set<number>();
	for (const functionId of affected) {
		const scc = topology.owner.get(functionId);
		if (scc !== undefined) {
			initialSccs.add(scc);
			pendingFunctionSccs.add(scc);
		}
	}
	if (aggregateInitiallyAffected && targets.graph.hasAggregate()) {
		const scc = topology.owner.get(CORE_ANY_SCRIPT_AGGREGATE);
		if (scc !== undefined) {
			initialSccs.add(scc);
			pendingAggregateSccs.add(scc);
		}
	}
	scheduler.solveSccs(
		topology,
		[...initialSccs].map((scc) => ({
			scc,
			dimensions: CORE_PROGRAM_FLOW_RETURN_KIND,
		})),
		(sccIndex, dimensions, enqueueScc) => {
			if ((dimensions & CORE_PROGRAM_FLOW_RETURN_KIND) === 0) return;
			const runFunctions = pendingFunctionSccs.delete(sccIndex);
			const runAggregate = pendingAggregateSccs.delete(sccIndex);
			const activateScc = (scc: number): void => {
				if (activeSccs.has(scc)) return;
				activeSccs.add(scc);
				const component = topology.sccs[scc]!;
				for (const functionId of component.functions) {
					affected.add(functionId);
					valueAnalyses.delete(functionId);
					summaries.set(functionId, seededSummary(functionId, anyScriptAggregate));
				}
				for (const functionId of component.functions) {
					for (const graphIndex of [targets, previous?.targets]) {
						if (graphIndex === undefined) continue;
						for (const neighbor of [
							...graphIndex.graph.exactOutgoing(functionId),
							...graphIndex.graph.exactCallers(functionId),
						]) {
							if (!live.has(neighbor)) continue;
							const neighborScc = topology.owner.get(neighbor);
							if (
								neighborScc !== undefined &&
								neighborScc !== scc &&
								!activeSccs.has(neighborScc)
							) {
								pendingFunctionSccs.add(neighborScc);
								enqueueScc(neighborScc, CORE_PROGRAM_FLOW_RETURN_KIND);
							}
						}
					}
				}
			};
			if (runFunctions) activateScc(sccIndex);
			const component = topology.sccs[sccIndex]!;
			const queue: Array<CoreCallGraphNode> = [
				...(runAggregate && component.hasAnyScriptAggregate
					? [CORE_ANY_SCRIPT_AGGREGATE]
					: []),
				...(runFunctions ? component.functions : []),
			];
			const queued = new Set<CoreCallGraphNode>(queue);
			const enqueueNode = (node: CoreCallGraphNode, caller: boolean): void => {
				const scc = topology.owner.get(node);
				if (scc === undefined) return;
				if (node === CORE_ANY_SCRIPT_AGGREGATE) pendingAggregateSccs.add(scc);
				else {
					pendingFunctionSccs.add(scc);
					activateScc(scc);
				}
				if (scc === sccIndex) {
					if (queued.has(node)) return;
					queued.add(node);
					queue.push(node);
					if (node === CORE_ANY_SCRIPT_AGGREGATE) pendingAggregateSccs.delete(scc);
					else pendingFunctionSccs.delete(scc);
				} else if (!enqueueScc(scc, CORE_PROGRAM_FLOW_RETURN_KIND)) {
					return;
				}
				if (caller) callerWakeups++;
				else calleeWakeups++;
			};
			const applyIncoming = (
				callee: CoreFunctionId,
				incomingParameterKinds: ReadonlyArray<CompilerValueKindMask>,
				strictReceiverKind: CompilerValueKindMask,
			): void => {
				if (!live.has(callee)) return;
				const calleeScc = topology.owner.get(callee);
				if (calleeScc === undefined) return;
				pendingFunctionSccs.add(calleeScc);
				activateScc(calleeScc);
				const calleeFn = program.function(callee);
				const prior = summaries.get(callee)!;
				const parameterKinds = [...prior.parameterKinds];
				for (let index = 0; index < calleeFn.parameterCount; index++) {
					parameterKinds[index] =
						parameterKinds[index]! | (incomingParameterKinds[index] ?? 0);
				}
				const incomingReceiver = calleeFn.metadata.strict
					? strictReceiverKind
					: COMPILER_VALUE_KIND_OBJECT;
				const receiverKind = prior.receiverKind | incomingReceiver;
				if (
					receiverKind === prior.receiverKind &&
					parameterKinds.every((kind, index) => kind === prior.parameterKinds[index])
				)
					return;
				summaries.set(callee, { ...prior, parameterKinds, receiverKind });
				enqueueNode(callee, false);
			};
			let cursor = 0;
			while (cursor < queue.length) {
				const node = queue[cursor++]!;
				queued.delete(node);
				if (node === CORE_ANY_SCRIPT_AGGREGATE) {
					const parameterKinds =
						Array<CompilerValueKindMask>(maximumParameterCount).fill(0);
					let strictReceiverKind = 0;
					for (const caller of targets.graph.wildcardCallers) {
						const contribution = wildcardContributions.get(caller);
						if (contribution === undefined) continue;
						for (let index = 0; index < maximumParameterCount; index++) {
							parameterKinds[index] =
								parameterKinds[index]! | (contribution.parameterKinds[index] ?? 0);
						}
						strictReceiverKind |= contribution.strictReceiverKind;
					}
					let returnKind = 0;
					for (const summary of summaries.values()) {
						aggregateFunctionVisits++;
						returnKind |= summary.returnKind;
					}
					const prior = anyScriptAggregate;
					const next: CoreProgramValueKindAggregate = {
						parameterKinds,
						strictReceiverKind,
						returnKind,
					};
					aggregateRecomputations++;
					anyScriptAggregate = next;
					if (prior?.returnKind !== returnKind) {
						for (const caller of targets.graph.wildcardCallers) {
							wildcardReverseCallerVisits++;
							enqueueNode(caller, true);
						}
					}
					if (!sameWildcardContribution(prior, next)) {
						for (const functionId of functionIds) enqueueNode(functionId, false);
						for (const callee of functionIds) {
							aggregateFunctionVisits++;
							applyIncoming(callee, parameterKinds, strictReceiverKind);
						}
						enqueueNode(CORE_ANY_SCRIPT_AGGREGATE, false);
					}
					continue;
				}
				const functionId = node;
				const fn = program.function(functionId);
				const summary = summaries.get(functionId)!;
				const sites = targets.outgoing(functionId);
				const byInstruction = new Map(sites.map((site) => [site.instruction, site]));
				const values = analyzeCoreValueKinds(fn, controlFlow(functionId), {
					parameterMasks: summary.parameterKinds,
					receiverMask: summary.receiverKind,
					operationResultMask(instruction) {
						const site = byInstruction.get(instruction);
						if (site === undefined) return undefined;
						if (
							site.targets.opaque ||
							(!targets.sourceClosed && site.targets.anyScript)
						) {
							return COMPILER_VALUE_KIND_TOP;
						}
						if (site.targets.anyScript) {
							return anyScriptAggregate?.returnKind ?? 0;
						}
						const callees = site.targets.functions;
						if (callees.length === 0) return COMPILER_VALUE_KIND_TOP;
						return callees.reduce(
							(mask, callee) => mask | summaries.get(callee)!.returnKind,
							0,
						);
					},
				});
				valueAnalyses.set(functionId, values);
				functionsEvaluated++;
				let returnKind = 0;
				const cfg = controlFlow(functionId);
				for (const block of cfg.reachable) {
					const terminator = fn.blockTerminator(block);
					if (fn.instructionKind(terminator) === "return") {
						returnKind |= values.latticeMask(
							fn.kernel.operandAt(fn.kernel.instructionOperandStart(terminator)),
						);
					}
				}
				if (returnKind !== summary.returnKind) {
					summaries.set(functionId, { ...summary, returnKind });
					for (const caller of targets.graph.exactCallers(functionId)) {
						exactReverseCallerVisits++;
						enqueueNode(caller, true);
					}
					if (targets.graph.hasAggregate()) {
						enqueueNode(CORE_ANY_SCRIPT_AGGREGATE, true);
					}
				}
				const anyScriptParameterKinds =
					Array<CompilerValueKindMask>(maximumParameterCount).fill(0);
				let anyScriptStrictReceiverKind = 0;
				let hasAnyScriptSite = false;
				for (const site of sites) {
					if (site.targets.anyScript) {
						hasAnyScriptSite = true;
						for (let index = 0; index < maximumParameterCount; index++) {
							const argument = site.arguments?.[index];
							anyScriptParameterKinds[index] =
								anyScriptParameterKinds[index]! |
								(site.arguments === undefined
									? COMPILER_VALUE_KIND_TOP
									: argument === undefined
										? COMPILER_VALUE_KIND_UNDEFINED
										: values.latticeMask(argument));
						}
						anyScriptStrictReceiverKind |=
							site.receiver === undefined
								? COMPILER_VALUE_KIND_TOP
								: values.latticeMask(site.receiver);
						continue;
					}
					const incomingParameterKinds =
						Array<CompilerValueKindMask>(maximumParameterCount);
					for (let index = 0; index < maximumParameterCount; index++) {
						const argument = site.arguments?.[index];
						incomingParameterKinds[index] =
							site.arguments === undefined
								? COMPILER_VALUE_KIND_TOP
								: argument === undefined
									? COMPILER_VALUE_KIND_UNDEFINED
									: values.latticeMask(argument);
					}
					for (const callee of site.targets.functions) {
						applyIncoming(
							callee,
							incomingParameterKinds,
							site.receiver === undefined
								? COMPILER_VALUE_KIND_TOP
								: values.latticeMask(site.receiver),
						);
					}
				}
				if (hasAnyScriptSite) {
					const contribution: CoreProgramValueKindWildcardContribution = {
						parameterKinds: anyScriptParameterKinds,
						strictReceiverKind: anyScriptStrictReceiverKind,
					};
					if (
						!sameWildcardContribution(wildcardContributions.get(functionId), contribution)
					) {
						wildcardContributions.set(functionId, contribution);
						enqueueNode(CORE_ANY_SCRIPT_AGGREGATE, false);
					}
				} else if (
					wildcardContributions.delete(functionId) &&
					targets.graph.hasAggregate()
				) {
					enqueueNode(CORE_ANY_SCRIPT_AGGREGATE, false);
				}
			}
		},
	);
	const changedFunctions = new Set(affected);
	for (const functionId of functionIds) {
		const frozen = freezeProgramValueKindSummary(summaries.get(functionId)!);
		summaries.set(functionId, frozen);
	}
	const statistics = Object.freeze({
		functions: functionIds.length,
		functionsEvaluated,
		functionsReused: functionIds.length - affected.size,
		affectedFunctions: affected.size,
		callerWakeups,
		calleeWakeups,
		aggregateRecomputations,
		exactReverseCallerVisits,
		wildcardReverseCallerVisits,
		aggregateFunctionVisits,
	});
	return Object.freeze({
		sourceClosed: targets.sourceClosed,
		targets,
		external,
		valueAnalyses,
		summaries,
		wildcardContributions,
		anyScriptAggregate,
		changedFunctions,
		statistics,
		values(functionId: CoreFunctionId) {
			const result = valueAnalyses.get(functionId);
			if (result === undefined)
				throw new Error(`No value-kind analysis for ${functionId}`);
			return result;
		},
		summary(functionId: CoreFunctionId) {
			const result = summaries.get(functionId);
			if (result === undefined)
				throw new Error(`No value-kind summary for ${functionId}`);
			return result;
		},
	});
}

function exactPrimitiveTypeof(mask: number): string | undefined {
	if (mask === COMPILER_VALUE_KIND_UNDEFINED) return "undefined";
	if (mask === COMPILER_VALUE_KIND_NULL) return "object";
	if (mask === COMPILER_VALUE_KIND_BOOLEAN) return "boolean";
	if (mask === COMPILER_VALUE_KIND_NUMBER) return "number";
	if (mask === COMPILER_VALUE_KIND_STRING) return "string";
	if (mask === COMPILER_VALUE_KIND_BIGINT) return "bigint";
	if (mask === COMPILER_VALUE_KIND_SYMBOL) return "symbol";
	return undefined;
}

function coreStringConstant(
	program: CoreProgram,
	fn: CoreFunctionStore,
	value: CoreValueId,
): string | undefined {
	if (fn.kernel.valueDefinitionKind(value) !== 1) return undefined;
	const definition = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
	if (
		fn.instructionKind(definition) !== "operation" ||
		fn.instructionOpcodeName(definition) !== "createString"
	)
		return undefined;
	const stringIndex = fn.instructionAttributes(definition).stringIndex;
	if (typeof stringIndex !== "number") return undefined;
	const units = program.stringConstants[stringIndex];
	return units === undefined ? undefined : String.fromCodePoint(...units);
}

export function coreValueKindObservation(
	program: CoreProgram,
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	kindMask: (value: CoreValueId) => CompilerValueKindMask,
): boolean | undefined {
	if (
		fn.instructionKind(instruction) !== "operation" ||
		fn.kernel.instructionResultCount(instruction) !== 1
	)
		return undefined;
	const opcode = fn.instructionOpcodeName(instruction);
	const operandStart = fn.kernel.instructionOperandStart(instruction);
	const operandCount = fn.kernel.instructionOperandCount(instruction);
	const operand = (index: number): CoreValueId | undefined =>
		index < operandCount ? fn.kernel.operandAt(operandStart + index) : undefined;
	if (opcode === "typeofCompare") {
		const input = operand(0);
		const expected = fn.instructionAttributes(instruction).expected;
		if (input === undefined || typeof expected !== "string") return undefined;
		const actual = exactPrimitiveTypeof(kindMask(input));
		if (actual === undefined) return undefined;
		const equal = actual === expected;
		return fn.instructionAttributes(instruction).negated === true ? !equal : equal;
	}
	if (opcode === "unary" && fn.instructionAttributes(instruction).operator === "!") {
		const input = operand(0);
		return input !== undefined &&
			compilerValueKindMaskIsSubset(
				kindMask(input),
				COMPILER_VALUE_KIND_UNDEFINED | COMPILER_VALUE_KIND_NULL,
			)
			? true
			: undefined;
	}
	if (opcode !== "binary" || operandCount !== 2) return undefined;
	const operator = fn.instructionAttributes(instruction).operator;
	if (operator !== "===" && operator !== "!==") return undefined;
	const typeofResult = (value: CoreValueId, other: CoreValueId): boolean | undefined => {
		if (fn.kernel.valueDefinitionKind(value) !== 1) return undefined;
		const definition = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
		if (
			fn.instructionKind(definition) !== "operation" ||
			fn.instructionOpcodeName(definition) !== "unary" ||
			fn.instructionAttributes(definition).operator !== "typeof"
		)
			return undefined;
		const input =
			fn.kernel.instructionOperandCount(definition) === 0
				? undefined
				: fn.kernel.operandAt(fn.kernel.instructionOperandStart(definition));
		const expected = coreStringConstant(program, fn, other);
		if (input === undefined || expected === undefined) return undefined;
		const actual = exactPrimitiveTypeof(kindMask(input));
		return actual === undefined ? undefined : actual === expected;
	};
	const left = operand(0)!;
	const right = operand(1)!;
	const equal =
		typeofResult(left, right) ??
		typeofResult(right, left) ??
		((kindMask(left) & kindMask(right)) === 0 ? false : undefined);
	return equal === undefined ? undefined : operator === "===" ? equal : !equal;
}

export function coreExactBinaryInputKindMasks(
	value: unknown,
): readonly [CompilerValueKindMask, CompilerValueKindMask] | undefined {
	if (
		!Array.isArray(value) ||
		value.length !== 2 ||
		!compilerValueKindMaskIsValid(value[0]) ||
		!compilerValueKindMaskIsValid(value[1])
	)
		return undefined;
	return value as unknown as readonly [CompilerValueKindMask, CompilerValueKindMask];
}

export function coreBinaryInputKindMasksHaveExactNativeSemantics(
	operator: unknown,
	masks: readonly [CompilerValueKindMask, CompilerValueKindMask],
): boolean {
	return (
		typeof operator === "string" &&
		COMPARISON_OPERATORS.has(operator) &&
		compilerValueKindMaskIsSubset(masks[0], COMPILER_VALUE_KIND_NUMBER_OR_UNDEFINED) &&
		compilerValueKindMaskIsSubset(masks[1], COMPILER_VALUE_KIND_NUMBER_OR_UNDEFINED)
	);
}

export function corePrimitiveOperatorEffectRefinement(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	masks: ReadonlyArray<CompilerValueKindMask>,
): CoreInstructionEffects | undefined {
	const opcode = fn.instructionOpcodeName(instruction);
	const operator = fn.instructionAttributes(instruction).operator;
	let primitive = false;
	let gcFree = false;
	if (opcode === "unary" && masks.length === 1 && typeof operator === "string") {
		const numberOnly = compilerValueKindMaskIsSubset(
			masks[0]!,
			COMPILER_VALUE_KIND_NUMBER,
		);
		primitive =
			NON_COERCING_UNARY_OPERATORS.has(operator) ||
			(NUMERIC_UNARY_OPERATORS.has(operator) && numberOnly);
		gcFree = NON_COERCING_UNARY_OPERATORS.has(operator) || numberOnly;
	} else if (opcode === "binary" && masks.length === 2 && typeof operator === "string") {
		const numbersOnly = masks.every((mask) =>
			compilerValueKindMaskIsSubset(mask, COMPILER_VALUE_KIND_NUMBER),
		);
		primitive =
			["===", "!=="].includes(operator) ||
			(NUMERIC_BINARY_OPERATORS.has(operator) && numbersOnly) ||
			(operator === "+" &&
				masks.every((mask) =>
					compilerValueKindMaskIsSubset(mask, COMPILER_VALUE_KIND_STRING),
				)) ||
			coreBinaryInputKindMasksHaveExactNativeSemantics(operator, [masks[0]!, masks[1]!]);
		gcFree =
			["===", "!=="].includes(operator) ||
			(numbersOnly &&
				(NUMERIC_BINARY_OPERATORS.has(operator) || COMPARISON_OPERATORS.has(operator)));
	}
	if (!primitive) return undefined;
	const baseline = fn.registry.byId(fn.instructionOpcode(instruction)).effects;
	return {
		reads: baseline.reads.filter((domain) => domain !== "host"),
		writes: baseline.writes.filter((domain) => domain !== "host"),
		mayThrow: false,
		maySuspend: baseline.maySuspend,
		mayGc: gcFree ? false : baseline.mayGc,
		callsUserCode: false,
	};
}

export function coreExactCallArgumentRepresentations(
	value: unknown,
	parameterCount?: number,
): ReadonlyArray<CoreExactCallArgumentRepresentation> | undefined {
	if (
		!Array.isArray(value) ||
		(parameterCount !== undefined && value.length !== parameterCount) ||
		value.some(
			(entry) =>
				entry !== "boxed" &&
				entry !== "int32" &&
				entry !== "number" &&
				entry !== "boolean" &&
				entry !== "string",
		)
	)
		return undefined;
	return value as ReadonlyArray<CoreExactCallArgumentRepresentation>;
}

export interface CoreExactValueFactSelection {
	readonly program: CoreProgram;
	readonly changed: boolean;
}

export function materializeCoreExactScalarRepresentations(
	program: CoreProgram,
): CoreExactValueFactSelection {
	return { program, changed: false };
}

export function selectCoreExactValueFacts(
	program: CoreProgram,
): CoreExactValueFactSelection {
	return { program, changed: false };
}
