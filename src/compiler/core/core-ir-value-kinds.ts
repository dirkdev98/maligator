import { builtinPrimitiveResult } from "../shared/builtin-semantics.ts";
import { compilerFactIsWorldInvariant } from "../shared/compiler-facts.ts";
import {
	COMPILER_VALUE_KIND_BIGINT,
	COMPILER_VALUE_KIND_BOOLEAN,
	COMPILER_VALUE_KIND_NULL,
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_NUMERIC_PRIMITIVE,
	compilerOperatorInputKindsHaveExactNativeSemantics,
	COMPILER_VALUE_KIND_OBJECT,
	COMPILER_VALUE_KIND_STRING,
	COMPILER_VALUE_KIND_SYMBOL,
	COMPILER_VALUE_KIND_TOP,
	COMPILER_VALUE_KIND_UNDEFINED,
	compilerValueKindMaskIsSubset,
	compilerValueKindMaskIsValid,
} from "../shared/compiler-value-kinds.ts";
import type {
	CompilerOperatorInputKindMasks,
	CompilerValueKindMask,
} from "../shared/compiler-value-kinds.ts";
import type { CoreAnalysisDefinition } from "./core-analysis-manager.ts";
import { coreClosedGlobalSlotMembership } from "./core-compilation.ts";
import type { CoreCompilationContext } from "./core-compilation.ts";
import type { CoreCallGraphIndex } from "./core-ir-call-targets.ts";
import {
	CORE_CONTROL_FLOW_BUNDLE_ANALYSIS,
	coreCanonicalValueRoots,
	coreTerminatorInput,
} from "./core-ir-control-flow.ts";
import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import type {
	CoreFunctionId,
	CoreBlockId,
	CoreInstructionEffects,
	CoreInstructionId,
	CoreValueId,
} from "./core-ir.ts";
import { coreInstructionId } from "./core-ir.ts";
import { CORE_OPTIMIZATION_OWNER } from "./core-optimization-owners.ts";
import { CoreProgramFlowEngine } from "./core-program-flow.ts";
import type {
	CoreProgramFlowValueKinds,
	CoreProgramFlowValueKindSemantics,
	CoreProgramFlowValueKindState,
	CoreProgramFlowValueKindStatistics,
	CoreProgramFlowValueKindSummary,
} from "./core-program-flow.ts";
import { coreExactArrayFromCallResult } from "./core-static-values.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

const BUILTIN_RESULT_KIND_MASKS = {
	number: COMPILER_VALUE_KIND_NUMBER,
	string: COMPILER_VALUE_KIND_STRING,
	boolean: COMPILER_VALUE_KIND_BOOLEAN,
	bigint: COMPILER_VALUE_KIND_BIGINT,
	symbol: COMPILER_VALUE_KIND_SYMBOL,
	"number-or-undefined": COMPILER_VALUE_KIND_NUMBER | COMPILER_VALUE_KIND_UNDEFINED,
	"string-or-undefined": COMPILER_VALUE_KIND_STRING | COMPILER_VALUE_KIND_UNDEFINED,
};

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
	readonly operationResultValue?: (
		instruction: CoreInstructionId,
		result: CoreValueId,
	) => CoreValueId | undefined;
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
const SIGNED_INT32_BINARY_OPERATORS: ReadonlySet<string> = new Set([
	"&",
	"|",
	"^",
	"<<",
	">>",
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

function staticOpcodeKind(opcode: string): CompilerValueKindMask | undefined {
	switch (opcode) {
		case "createUndefined":
			return COMPILER_VALUE_KIND_UNDEFINED;
		case "createNull":
			return COMPILER_VALUE_KIND_NULL;
		case "createBoolean":
			return COMPILER_VALUE_KIND_BOOLEAN;
		case "createF64":
		case "createNumber":
		case "preparedStringCompare":
		case "preciseNumberSum":
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

const KIND_TRANSFER_JOIN = 1;
const KIND_TRANSFER_COPY = 2;
const KIND_TRANSFER_NUMERIC_UNARY = 3;
const KIND_TRANSFER_BINARY = 4;
const KIND_TRANSFER_ADD = 5;

function isNumberValue(fn: CoreFunctionStore, value: CoreValueId): boolean {
	const representation = fn.valueRepresentation(value);
	if (representation === "f64" || representation === "i32") return true;
	if (fn.kernel.valueDefinitionKind(value) !== 1) return false;
	const definition = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
	if (fn.instructionKind(definition) !== "operation") return false;
	return ["createF64", "createI32", "createNumber"].includes(
		fn.instructionOpcodeName(definition),
	);
}

function isLengthProperty(
	program: CoreProgram,
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): boolean {
	const stringIndex = fn.instructionAttributes(instruction).stringIndex;
	return (
		typeof stringIndex === "number" && stringConstantIs(program, stringIndex, "length")
	);
}

function stringConstantIs(
	program: CoreProgram,
	index: number,
	expected: string,
): boolean {
	const units = program.stringConstants[index];
	return (
		units?.length === expected.length &&
		units.every((unit, offset) => unit === expected.charCodeAt(offset))
	);
}

export interface CorePrivateArrayUseSummary {
	readonly allocation: CoreInstructionId;
	readonly root: CoreValueId;
	readonly lengthLoads: ReadonlyArray<CoreInstructionId>;
	readonly elementLoads: ReadonlyArray<CoreInstructionId>;
	readonly elementStores: ReadonlyArray<CoreInstructionId>;
}

export type CorePrivateNumericArray = CorePrivateArrayUseSummary;

interface CorePrivateArraySeed {
	readonly allocation: CoreInstructionId;
	readonly root: CoreValueId;
}

function privateArrayUses(
	program: CoreProgram,
	fn: CoreFunctionStore,
	cfg: CoreControlFlow,
	seeds: ReadonlyArray<CorePrivateArraySeed>,
	numberValue: (value: CoreValueId) => boolean = (value) => isNumberValue(fn, value),
): ReadonlyArray<CorePrivateArrayUseSummary> {
	const roots = coreCanonicalValueRoots(fn, cfg);
	const root = (value: CoreValueId): CoreValueId => roots.get(value) ?? value;
	const candidates = new Map<
		CoreValueId,
		{
			allocation: CoreInstructionId;
			lengthLoads: Array<CoreInstructionId>;
			elementLoads: Array<CoreInstructionId>;
			elementStores: Array<CoreInstructionId>;
		}
	>();
	for (const seed of seeds) {
		candidates.set(root(seed.root), {
			allocation: seed.allocation,
			lengthLoads: [],
			elementLoads: [],
			elementStores: [],
		});
	}
	if (candidates.size === 0) return [];

	const reject = new Set<CoreValueId>();
	for (const block of fn.blockIds()) {
		const incoming = cfg.predecessors[block] ?? [];
		if (incoming.length === 0) continue;
		const parameterStart = fn.kernel.blockParameterStart(block);
		const parameterCount = fn.kernel.blockParameterCount(block);
		for (let index = 0; index < parameterCount; index++) {
			const row = parameterStart + index;
			if (fn.kernel.blockParameterRole(row) === 1) continue;
			const parameterRoot = root(fn.kernel.blockParameterValue(row));
			for (const edge of incoming) {
				const argument = edge.arguments[edge.kind === "exceptional" ? index - 1 : index];
				if (argument === undefined) continue;
				const argumentRoot = root(argument);
				if (candidates.has(argumentRoot) && parameterRoot !== argumentRoot) {
					reject.add(argumentRoot);
				}
			}
		}
	}
	for (const block of fn.blockIds()) {
		const input = coreTerminatorInput(fn, fn.blockTerminator(block));
		const observed =
			input.kind === "branch" || input.kind === "guard"
				? input.condition
				: input.kind === "switch"
					? input.discriminant
					: input.kind === "return" || input.kind === "throw"
						? input.value
						: undefined;
		if (observed === undefined) continue;
		const valueRoot = root(observed);
		if (candidates.has(valueRoot)) reject.add(valueRoot);
	}
	for (const instruction of fn.instructionIds()) {
		if (fn.instructionKind(instruction) !== "operation") continue;
		const opcode = fn.instructionOpcodeName(instruction);
		const operandStart = fn.kernel.instructionOperandStart(instruction);
		const operandCount = fn.kernel.instructionOperandCount(instruction);
		for (let position = 0; position < operandCount; position++) {
			const valueRoot = root(fn.kernel.operandAt(operandStart + position));
			const candidate = candidates.get(valueRoot);
			if (candidate === undefined || reject.has(valueRoot)) continue;
			if (
				position === 0 &&
				(opcode === "move" || opcode === "rootUse" || opcode === "throwIfTdz")
			)
				continue;
			if (
				position === 0 &&
				opcode === "loadPropertyStatic" &&
				isLengthProperty(program, fn, instruction)
			) {
				candidate.lengthLoads.push(instruction);
				continue;
			}
			if (
				position === 0 &&
				opcode === "loadProperty" &&
				operandCount === 2 &&
				numberValue(fn.kernel.operandAt(operandStart + 1))
			) {
				candidate.elementLoads.push(instruction);
				continue;
			}
			if (
				position === 0 &&
				opcode === "storeProperty" &&
				operandCount === 3 &&
				numberValue(fn.kernel.operandAt(operandStart + 1)) &&
				numberValue(fn.kernel.operandAt(operandStart + 2))
			) {
				candidate.elementStores.push(instruction);
				continue;
			}
			reject.add(valueRoot);
		}
	}
	return Object.freeze(
		[...candidates].flatMap(([valueRoot, candidate]) =>
			reject.has(valueRoot)
				? []
				: [
						Object.freeze({
							allocation: candidate.allocation,
							root: valueRoot,
							lengthLoads: Object.freeze(candidate.lengthLoads),
							elementLoads: Object.freeze(candidate.elementLoads),
							elementStores: Object.freeze(candidate.elementStores),
						}),
					],
		),
	);
}

function privateNumericArraySeeds(fn: CoreFunctionStore): Array<CorePrivateArraySeed> {
	const seeds: Array<CorePrivateArraySeed> = [];
	for (const instruction of fn.instructionIds()) {
		if (
			fn.instructionKind(instruction) !== "operation" ||
			fn.instructionOpcodeName(instruction) !== "createArray" ||
			fn.instructionAttributes(instruction).length !== 0 ||
			fn.kernel.instructionResultCount(instruction) !== 1
		)
			continue;
		seeds.push({
			allocation: instruction,
			root: fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction)),
		});
	}
	return seeds;
}

function privatePackedRestArraySeeds(fn: CoreFunctionStore): Array<CorePrivateArraySeed> {
	const seeds: Array<CorePrivateArraySeed> = [];
	for (const instruction of fn.instructionIds()) {
		if (
			fn.instructionKind(instruction) !== "operation" ||
			fn.instructionOpcodeName(instruction) !== "createRestArguments" ||
			fn.kernel.instructionResultCount(instruction) !== 1
		)
			continue;
		seeds.push({
			allocation: instruction,
			root: fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction)),
		});
	}
	return seeds;
}

function privateArrayFromSeeds(
	program: CoreProgram,
	fn: CoreFunctionStore,
	cfg: CoreControlFlow,
	context: CoreCompilationContext,
): Array<CorePrivateArraySeed> {
	const seeds: Array<CorePrivateArraySeed> = [];
	for (const instruction of fn.instructionIds()) {
		const result = coreExactArrayFromCallResult(program, fn, cfg, context, instruction);
		if (result === undefined) continue;
		seeds.push({ allocation: instruction, root: result });
	}
	return seeds;
}

function privateArrayPolicyIsLocked(context: CoreCompilationContext): boolean {
	return (
		context.facts.world.primordialPolicy === "locked" &&
		compilerFactIsWorldInvariant(context.facts.protectors.get("array-elements"))
	);
}

export function corePrivateNumericArrays(
	program: CoreProgram,
	fn: CoreFunctionStore,
	cfg: CoreControlFlow,
	context: CoreCompilationContext,
): ReadonlyArray<CorePrivateNumericArray> {
	return privateArrayPolicyIsLocked(context)
		? privateArrayUses(program, fn, cfg, privateNumericArraySeeds(fn))
		: [];
}

export function corePrivateArrayLengthCandidates(
	program: CoreProgram,
	fn: CoreFunctionStore,
	cfg: CoreControlFlow,
	context: CoreCompilationContext,
): ReadonlyArray<CorePrivateArrayUseSummary> {
	if (!privateArrayPolicyIsLocked(context)) return [];
	return privateArrayUses(program, fn, cfg, [
		...privateNumericArraySeeds(fn),
		...privateArrayFromSeeds(program, fn, cfg, context),
	]);
}

export function corePrivateNumericArrayLoads(
	program: CoreProgram,
	fn: CoreFunctionStore,
	cfg: CoreControlFlow,
	context: CoreCompilationContext,
): ReadonlySet<CoreInstructionId> {
	return new Set(
		corePrivateNumericArrays(program, fn, cfg, context).flatMap(
			(array) => array.elementLoads,
		),
	);
}

export function corePrivatePackedRestArrayLoads(
	program: CoreProgram,
	fn: CoreFunctionStore,
	cfg: CoreControlFlow,
	context: CoreCompilationContext,
	numberValue: (value: CoreValueId) => boolean,
): ReadonlySet<CoreInstructionId> {
	if (!privateArrayPolicyIsLocked(context)) return new Set();
	return new Set(
		privateArrayUses(program, fn, cfg, privatePackedRestArraySeeds(fn), numberValue)
			.filter((array) => array.elementStores.length === 0)
			.flatMap((array) => array.elementLoads),
	);
}

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
	inputs?: ReadonlyArray<CoreValueId>,
): void {
	buffer.kinds.push(kind);
	buffer.outputs.push(output);
	buffer.constants.push(constant);
	buffer.inputStarts.push(buffer.inputs.length);
	buffer.inputCounts.push(inputs?.length ?? 0);
	if (inputs !== undefined) {
		for (const input of inputs) buffer.inputs.push(input);
	}
}

function addOperationKindTransfer(
	buffer: KindTransferBuffer,
	kind: number,
	output: CoreValueId,
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): void {
	const operandStart = fn.kernel.instructionOperandStart(instruction);
	const operandCount = fn.kernel.instructionOperandCount(instruction);
	buffer.kinds.push(kind);
	buffer.outputs.push(output);
	buffer.constants.push(0);
	buffer.inputStarts.push(buffer.inputs.length);
	buffer.inputCounts.push(operandCount);
	for (let index = 0; index < operandCount; index++) {
		buffer.inputs.push(fn.kernel.operandAt(operandStart + index));
	}
}

function addOperationTransfer(
	buffer: KindTransferBuffer,
	masks: Uint16Array,
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	output: CoreValueId,
	inputs?: CoreValueKindInputs,
): void {
	const representation = representationKind(fn, output);
	if (representation !== undefined) {
		masks[output] = masks[output]! | representation;
		return;
	}
	const opcode = fn.instructionOpcodeName(instruction);
	const staticKind = staticOpcodeKind(opcode);
	if (staticKind !== undefined) {
		masks[output] = masks[output]! | staticKind;
		return;
	}
	if (opcode === "queryStaticData") {
		const kind = fn.instructionAttributes(instruction).queryKind;
		masks[output] =
			masks[output]! |
			(kind === "index-of" || kind === "last-index-of"
				? COMPILER_VALUE_KIND_NUMBER
				: COMPILER_VALUE_KIND_BOOLEAN);
		return;
	}
	if (opcode === "loadThis" && inputs?.receiverMask !== undefined) {
		masks[output] = masks[output]! | inputs.receiverMask;
		return;
	}
	const supplied = inputs?.operationResultMask?.(instruction, output);
	if (supplied !== undefined) {
		masks[output] = masks[output]! | supplied;
		return;
	}
	if (opcode === "callKnown") {
		const attributes = fn.instructionAttributes(instruction);
		const result =
			!attributes.construct && typeof attributes.operation === "string"
				? builtinPrimitiveResult(attributes.operation)
				: undefined;
		const mask = result === undefined ? undefined : BUILTIN_RESULT_KIND_MASKS[result];
		if (mask !== undefined) {
			masks[output] = masks[output]! | mask;
			return;
		}
	}
	const forwarded = inputs?.operationResultValue?.(instruction, output);
	if (forwarded !== undefined) {
		addKindTransfer(buffer, KIND_TRANSFER_COPY, output, 0, [forwarded]);
		return;
	}
	const operandCount = fn.kernel.instructionOperandCount(instruction);
	if (opcode === "move" && operandCount === 1) {
		addOperationKindTransfer(buffer, KIND_TRANSFER_COPY, output, fn, instruction);
		return;
	}
	const operator =
		opcode === "unary" || opcode === "binary"
			? fn.instructionAttributes(instruction).operator
			: undefined;
	if (opcode === "unary" && operandCount === 1 && typeof operator === "string") {
		const constant =
			operator === "+"
				? COMPILER_VALUE_KIND_NUMBER
				: operator === "!"
					? COMPILER_VALUE_KIND_BOOLEAN
					: operator === "typeof" || operator === "tostring"
						? COMPILER_VALUE_KIND_STRING
						: operator === "void"
							? COMPILER_VALUE_KIND_UNDEFINED
							: undefined;
		if (constant !== undefined) {
			masks[output] = masks[output]! | constant;
		} else if (NUMERIC_UNARY_OPERATORS.has(operator)) {
			addOperationKindTransfer(
				buffer,
				KIND_TRANSFER_NUMERIC_UNARY,
				output,
				fn,
				instruction,
			);
		} else {
			masks[output] = COMPILER_VALUE_KIND_TOP;
		}
		return;
	}
	if (opcode === "binary" && operandCount === 2 && typeof operator === "string") {
		if (COMPARISON_OPERATORS.has(operator)) {
			masks[output] = masks[output]! | COMPILER_VALUE_KIND_BOOLEAN;
		} else if (operator === "+") {
			addOperationKindTransfer(buffer, KIND_TRANSFER_ADD, output, fn, instruction);
		} else if (NUMERIC_BINARY_OPERATORS.has(operator)) {
			addOperationKindTransfer(buffer, KIND_TRANSFER_BINARY, output, fn, instruction);
		} else {
			masks[output] = COMPILER_VALUE_KIND_TOP;
		}
		return;
	}
	masks[output] = COMPILER_VALUE_KIND_TOP;
}

export function analyzeCoreValueKinds(
	fn: CoreFunctionStore,
	cfg: CoreControlFlow,
	inputs?: CoreValueKindInputs,
): CoreValueKindAnalysis {
	const masks = new Uint16Array(fn.valueCapacity);
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
				masks[parameter] = masks[parameter]! | kind;
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
				addOperationTransfer(transfers, masks, fn, instruction, output, inputs);
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
	const queue = new Array<number>(transferOutputs.length);
	for (let index = 0; index < queue.length; index++) queue[index] = index;
	const queued = new Uint8Array(transferOutputs.length);
	queued.fill(1);
	let cursor = 0;
	while (cursor < queue.length) {
		const index = queue[cursor++]!;
		queued[index] = 0;
		const output = transferOutputs[index]! as CoreValueId;
		if (masks[output] === COMPILER_VALUE_KIND_TOP) continue;
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
			const input = mask(transferInputs[inputStart]! as CoreValueId);
			incoming =
				input === 0
					? 0
					: compilerValueKindMaskIsSubset(input, COMPILER_VALUE_KIND_NUMERIC_PRIMITIVE)
						? COMPILER_VALUE_KIND_NUMBER
						: COMPILER_VALUE_KIND_TOP;
		} else if (kind === KIND_TRANSFER_BINARY || kind === KIND_TRANSFER_ADD) {
			const left = mask(transferInputs[inputStart]! as CoreValueId);
			const right = mask(transferInputs[inputStart + 1]! as CoreValueId);
			if (left === 0 || right === 0) incoming = 0;
			else if (kind === KIND_TRANSFER_BINARY) {
				incoming =
					compilerValueKindMaskIsSubset(left, COMPILER_VALUE_KIND_NUMERIC_PRIMITIVE) ||
					compilerValueKindMaskIsSubset(right, COMPILER_VALUE_KIND_NUMERIC_PRIMITIVE)
						? COMPILER_VALUE_KIND_NUMBER
						: COMPILER_VALUE_KIND_TOP;
			} else if (
				compilerValueKindMaskIsSubset(left, COMPILER_VALUE_KIND_STRING) ||
				compilerValueKindMaskIsSubset(right, COMPILER_VALUE_KIND_STRING)
			) {
				incoming = COMPILER_VALUE_KIND_STRING;
			} else {
				incoming =
					compilerValueKindMaskIsSubset(left, COMPILER_VALUE_KIND_NUMERIC_PRIMITIVE) &&
					compilerValueKindMaskIsSubset(right, COMPILER_VALUE_KIND_NUMERIC_PRIMITIVE)
						? COMPILER_VALUE_KIND_NUMBER
						: COMPILER_VALUE_KIND_TOP;
			}
		}
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
		const operator = fn.instructionAttributes(definition).operator;
		if (
			masks[value] === COMPILER_VALUE_KIND_NUMBER &&
			((opcode === "unary" && operator === "~") ||
				(opcode === "binary" &&
					typeof operator === "string" &&
					SIGNED_INT32_BINARY_OPERATORS.has(operator)))
		)
			exactInt32[value] = 1;
	}
	const exactQueue: Array<number> = [];
	const exactQueued = new Uint8Array(transferOutputs.length);
	for (let index = 0; index < transferOutputs.length; index++) {
		const kind = transferKinds[index]!;
		if (kind !== KIND_TRANSFER_JOIN && kind !== KIND_TRANSFER_COPY) continue;
		exactQueue.push(index);
		exactQueued[index] = 1;
	}
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
		for (let dependency = dependentHeads[output]!; dependency >= 0; ) {
			const transfer = dependentTransfers[dependency]!;
			dependency = dependentNext[dependency]!;
			const kind = transferKinds[transfer]!;
			if (
				exactQueued[transfer] !== 0 ||
				(kind !== KIND_TRANSFER_JOIN && kind !== KIND_TRANSFER_COPY)
			)
				continue;
			exactQueued[transfer] = 1;
			exactQueue.push(transfer);
		}
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
		owner: CORE_OPTIMIZATION_OWNER.localValueKinds,
		functionDependencies: ["body", "cfg", "representations"],
		contextIdentity: (context) => context,
		compute({ program, context, request, get }) {
			if (request.scope !== "function") throw new Error("Expected function analysis");
			const fn = program.function(request.function);
			const cfg = get(CORE_CONTROL_FLOW_BUNDLE_ANALYSIS, request).exceptional();
			const numericArrayLoads = corePrivateNumericArrayLoads(program, fn, cfg, context);
			const operationResultMask = (instruction: CoreInstructionId) =>
				numericArrayLoads.has(instruction)
					? COMPILER_VALUE_KIND_NUMBER | COMPILER_VALUE_KIND_UNDEFINED
					: undefined;
			if (context.data.singleAssignmentGlobalSlots.length === 0) {
				return analyzeCoreValueKinds(fn, cfg, { operationResultMask });
			}
			const closedGlobals = coreClosedGlobalSlotMembership(context);
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
			if (stores.size === 0)
				return analyzeCoreValueKinds(fn, cfg, { operationResultMask });
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
			const operationResultValue = (
				instruction: CoreInstructionId,
			): CoreValueId | undefined => {
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
				return dominates ? store.value : undefined;
			};
			return analyzeCoreValueKinds(fn, cfg, {
				operationResultMask,
				operationResultValue,
			});
		},
	};

export type CoreProgramValueKindSummary = CoreProgramFlowValueKindSummary;
export type CoreProgramValueKindStatistics = CoreProgramFlowValueKindStatistics;
export type CoreProgramValueKinds = CoreProgramFlowValueKinds<CoreValueKindAnalysis>;
export type CoreProgramValueKindState = CoreProgramFlowValueKindState<
	CoreValueKindAnalysis,
	CoreCallGraphIndex
>;

export const CORE_PROGRAM_FLOW_VALUE_KIND_SEMANTICS: CoreProgramFlowValueKindSemantics<CoreValueKindAnalysis> =
	Object.freeze({
		analyze: analyzeCoreValueKinds,
		latticeMask(analysis: CoreValueKindAnalysis, value: CoreValueId) {
			return analysis.latticeMask(value);
		},
		top: COMPILER_VALUE_KIND_TOP,
		object: COMPILER_VALUE_KIND_OBJECT,
		undefined: COMPILER_VALUE_KIND_UNDEFINED,
	});

export function solveCoreProgramValueKinds(
	program: CoreProgram,
	targets: CoreCallGraphIndex,
	externallyReachable: (functionId: CoreFunctionId) => boolean,
	controlFlow: (functionId: CoreFunctionId) => CoreControlFlow,
	previous?: CoreProgramValueKindState,
	dirtyFunctions?: ReadonlyArray<CoreFunctionId>,
	externallyChangedFunctions?: ReadonlySet<CoreFunctionId>,
): CoreProgramValueKindState {
	return new CoreProgramFlowEngine(program).solveValueKinds(
		targets,
		externallyReachable,
		controlFlow,
		CORE_PROGRAM_FLOW_VALUE_KIND_SEMANTICS,
		previous,
		dirtyFunctions,
		externallyChangedFunctions,
	);
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

export function coreExactOperatorInputKindMasks(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): CompilerOperatorInputKindMasks | undefined {
	const refinement = fn.instructionEffectRefinement(instruction);
	if (refinement === undefined) return undefined;
	const fact = fn.fact(refinement.proof);
	const masks = fact.value;
	return fact.kind === CORE_PRIMITIVE_OPERATOR_EFFECT_FACT &&
		Array.isArray(masks) &&
		masks.every((mask) => compilerValueKindMaskIsValid(mask)) &&
		compilerOperatorInputKindsHaveExactNativeSemantics(
			fn.instructionOpcodeName(instruction),
			fn.instructionAttributes(instruction).operator,
			masks,
		)
		? masks
		: undefined;
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
		const numericPrimitive = compilerValueKindMaskIsSubset(
			masks[0]!,
			COMPILER_VALUE_KIND_NUMERIC_PRIMITIVE,
		);
		primitive =
			NON_COERCING_UNARY_OPERATORS.has(operator) ||
			(NUMERIC_UNARY_OPERATORS.has(operator) && numericPrimitive);
		gcFree = NON_COERCING_UNARY_OPERATORS.has(operator) || numericPrimitive;
	} else if (opcode === "binary" && masks.length === 2 && typeof operator === "string") {
		const numericPrimitives = masks.every((mask) =>
			compilerValueKindMaskIsSubset(mask, COMPILER_VALUE_KIND_NUMERIC_PRIMITIVE),
		);
		primitive =
			["===", "!=="].includes(operator) ||
			(NUMERIC_BINARY_OPERATORS.has(operator) && numericPrimitives) ||
			(operator === "+" &&
				masks.every((mask) =>
					compilerValueKindMaskIsSubset(mask, COMPILER_VALUE_KIND_STRING),
				)) ||
			compilerOperatorInputKindsHaveExactNativeSemantics(opcode, operator, masks);
		gcFree =
			["===", "!=="].includes(operator) ||
			(numericPrimitives &&
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
