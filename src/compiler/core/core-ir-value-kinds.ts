import {
	builtinNormalResultKinds,
	builtinResultIsInt32,
	builtinPreservesIntegerInput,
} from "../shared/builtin-registry.ts";
import { compilerFactIsWorldInvariant } from "../shared/compiler-facts.ts";
import {
	COMPILER_VALUE_KIND_BIGINT,
	COMPILER_VALUE_KIND_BOOLEAN,
	COMPILER_VALUE_KIND_NULL,
	COMPILER_VALUE_KIND_NULLISH,
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_NUMERIC_PRIMITIVE,
	COMPILER_VALUE_KIND_TO_NUMBER_PRIMITIVE,
	COMPILER_VALUE_KIND_TO_STRING_PRIMITIVE,
	compilerOperatorInputKindsHaveExactNativeSemantics,
	compilerComparisonInputKindsAvoidObjectCoercion,
	compilerOperatorIsNullishEquality,
	compilerOperatorIsPrimitiveStringConcatenation,
	compilerOperatorFixedResultKind,
	compilerNumericResultKind,
	COMPILER_NUMERIC_UNARY_OPERATORS as NUMERIC_UNARY_OPERATORS,
	COMPILER_NUMERIC_BINARY_OPERATORS as NUMERIC_BINARY_OPERATORS,
	COMPILER_VALUE_KIND_OBJECT,
	COMPILER_VALUE_KIND_STRING,
	COMPILER_VALUE_KIND_SYMBOL,
	COMPILER_VALUE_KIND_TOP,
	COMPILER_VALUE_KIND_UNDEFINED,
	compilerValueKindMaskIsSubset,
	compilerValueKindsHaveEmptyPrimitiveWrappers,
	compilerValueKindMaskIsValid,
	compilerTypeofComparison,
} from "../shared/compiler-value-kinds.ts";
import type {
	CompilerOperatorInputKindMasks,
	CompilerValueKindMask,
} from "../shared/compiler-value-kinds.ts";
import { NO_EFFECT_SUMMARY } from "../shared/effect-summary.ts";
import type { CompilerIntegerRange } from "../shared/integer-range.ts";
import {
	COMPILER_STRING_LENGTH_RANGE,
	COMPILER_UINT32_RANGE,
	compilerIntegerRangeIsInt32,
	compilerIntegerRangeIsValid,
	compilerIntegerRangeComparison,
} from "../shared/integer-range.ts";
import { validateStaticQueryTemplate } from "../shared/literal-template-data.ts";
import { STATIC_DATA_QUERY_POLL_INTERVAL } from "../shared/static-data-query.ts";
import type { CoreAnalysisDefinition } from "./core-analysis-manager.ts";
import { coreBuiltinResultProjection } from "./core-builtin-result-projections.ts";
import { coreClosedGlobalSlotMembership } from "./core-compilation.ts";
import type { CoreCompilationContext } from "./core-compilation.ts";
import { analyzeCoreConditionalValueKinds } from "./core-conditional-value-kinds.ts";
import type { CoreConditionalValueKinds } from "./core-conditional-value-kinds.ts";
import {
	CORE_CALL_RESULT_KIND_ATTRIBUTE,
	CORE_RECORD_FIELD_KIND_ATTRIBUTE,
	CORE_NORMAL_RESULT_INTEGER_RANGE_ATTRIBUTE,
	CORE_EXACT_TYPED_ARRAY_KIND_ATTRIBUTE,
} from "./core-internal-attributes.ts";
import type { CoreCallGraphIndex } from "./core-ir-call-targets.ts";
import {
	CORE_CONTROL_FLOW_BUNDLE_ANALYSIS,
	coreCanonicalValueRoots,
	coreTerminatorInput,
} from "./core-ir-control-flow.ts";
import type {
	CoreControlFlow,
	CoreControlEdge,
	CoreControlPoint,
} from "./core-ir-control-flow.ts";
import { coreNumericTypedArrayKind } from "./core-ir-value-classes.ts";
import type {
	CoreFunctionId,
	CoreBlockId,
	CoreInstructionEffects,
	CoreInstructionId,
	CoreValueId,
} from "./core-ir.ts";
import { coreInstructionId } from "./core-ir.ts";
import { CORE_OPTIMIZATION_OWNER } from "./core-optimization-owners.ts";
import type { CoreOptimizationOwnerRunner } from "./core-optimization-owners.ts";
import { corePrivateFieldFacts } from "./core-private-field-facts.ts";
import { CoreProgramFlowEngine } from "./core-program-flow.ts";
import type {
	CoreValueKindAlternatives,
	CoreProgramFlowValueKinds,
	CoreProgramFlowValueKindSemantics,
	CoreProgramFlowValueKindInputs,
	CoreProgramFlowValueKindState,
	CoreProgramFlowValueKindStatistics,
	CoreProgramFlowValueKindSummary,
} from "./core-program-flow.ts";
import type { CoreRecordValueKind } from "./core-record-value-kinds.ts";
import {
	coreReturnedValueDefinition,
	coreRecordReturnKindInputs,
	coreRecordFieldReads,
	coreReturnedRecordKinds,
} from "./core-record-value-kinds.ts";
import { coreExactArrayFromCallResult } from "./core-static-values.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

export const CORE_PRIMITIVE_EFFECT_FACT = "primitive-effects";

// Static queries can poll internally even when their key conversion cannot throw or reenter.
const STATIC_OWN_KEY_EFFECTS: CoreInstructionEffects = Object.freeze({
	...NO_EFFECT_SUMMARY,
	mayGc: true,
});

export type CoreExactScalarKind = "int32" | "number" | "boolean" | "string";
export type CoreExactCallArgumentRepresentation = "boxed" | CoreExactScalarKind;

export interface CoreValueKindAnalysis {
	readonly statistics: {
		readonly integerQueries: number;
		readonly integerValues: number;
		readonly integerSnapshotBytes: number;
	};
	kindMask(value: CoreValueId): CompilerValueKindMask;
	latticeMask(value: CoreValueId): CompilerValueKindMask;
	scalarKind(value: CoreValueId): Exclude<CoreExactScalarKind, "int32"> | undefined;
	exactScalar(value: CoreValueId): CoreExactScalarKind | undefined;
}

export interface CoreValueKindInputs {
	readonly runOwner?: CoreOptimizationOwnerRunner;
	readonly onIntegerWork?: (values: number) => void;
	readonly parameterMasks?: ReadonlyArray<CompilerValueKindMask>;
	readonly receiverMask?: CompilerValueKindMask;
	readonly controlEdges?: ReadonlySet<CoreControlEdge>;
	readonly operationResultValue?: (
		instruction: CoreInstructionId,
		result: CoreValueId,
	) => CoreValueId | undefined;
	readonly operationResultMask?: (
		instruction: CoreInstructionId,
		result: CoreValueId,
	) => CompilerValueKindMask | undefined;
	readonly operationResultAlternatives?: (
		instruction: CoreInstructionId,
		result: CoreValueId,
	) => CoreValueKindAlternatives | undefined;
	/** What a keyed read returns when its key is a number, if the receiver's elements are known. */
	readonly elementLoadMask?: (
		instruction: CoreInstructionId,
	) => CompilerValueKindMask | undefined;
	/**
	 * What a keyed read of a numeric TypedArray returns for a Number key. Any other
	 * key can reach an expando or a prototype member.
	 */
	readonly typedElementLoadMask?: (
		instruction: CoreInstructionId,
	) => CompilerValueKindMask | undefined;
}

const NON_COERCING_UNARY_OPERATORS: ReadonlySet<string> = new Set([
	"!",
	"typeof",
	"void",
]);
const SIGNED_INT32_BINARY_OPERATORS: ReadonlySet<string> = new Set([
	"&",
	"|",
	"^",
	"<<",
	">>",
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

function callResultKind(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): CompilerValueKindMask | undefined {
	if (
		fn.registry.byId(fn.instructionOpcode(instruction)).callTransfer?.result !==
		"call-completion"
	)
		return undefined;
	const mask = fn.instructionAttributes(instruction)[CORE_CALL_RESULT_KIND_ATTRIBUTE];
	return typeof mask === "number" && compilerValueKindMaskIsValid(mask)
		? mask
		: undefined;
}

function recordFieldKind(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): CompilerValueKindMask | undefined {
	const opcode = fn.instructionOpcodeName(instruction);
	if (opcode !== "loadProperty" && opcode !== "loadPropertyStatic") return undefined;
	const mask = fn.instructionAttributes(instruction)[CORE_RECORD_FIELD_KIND_ATTRIBUTE];
	return typeof mask === "number" && compilerValueKindMaskIsValid(mask)
		? mask
		: undefined;
}

/** The result equals this operand only when that operand is a proved primitive integer. */
export function coreIntegerPreservedResultInput(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): CoreValueId | undefined {
	if (fn.instructionKind(instruction) !== "operation") return undefined;
	const opcode = fn.instructionOpcodeName(instruction);
	if (opcode !== "mathUnaryNumber" && opcode !== "callKnown") return undefined;
	const attributes = fn.instructionAttributes(instruction);
	if (opcode === "callKnown") {
		const projection = coreBuiltinResultProjection(fn, instruction);
		if (projection !== undefined) {
			const resultKinds = builtinNormalResultKinds(attributes.operation as string);
			return (projection.identityKinds === undefined ||
				(projection.identityKinds & COMPILER_VALUE_KIND_NUMBER) !== 0) &&
				(resultKinds === undefined || (resultKinds & COMPILER_VALUE_KIND_NUMBER) !== 0)
				? projection.input
				: undefined;
		}
	}
	if (
		attributes.construct ||
		attributes.argumentMode !== undefined ||
		typeof attributes.operation !== "string" ||
		!builtinPreservesIntegerInput(attributes.operation)
	)
		return undefined;
	const input = opcode === "mathUnaryNumber" ? 0 : 1;
	return fn.kernel.instructionOperandCount(instruction) <= input
		? undefined
		: fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction) + input);
}

export function coreInstructionResultIntegerRange(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): CompilerIntegerRange | undefined {
	const range =
		fn.instructionAttributes(instruction)[CORE_NORMAL_RESULT_INTEGER_RANGE_ATTRIBUTE];
	return compilerIntegerRangeIsValid(range) &&
		(callResultKind(fn, instruction) ?? recordFieldKind(fn, instruction)) ===
			COMPILER_VALUE_KIND_NUMBER
		? range
		: undefined;
}

export function coreInstructionLengthIntegerRange(
	program: CoreProgram,
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	kinds?: Pick<CoreValueKindAnalysis, "kindMask">,
): CompilerIntegerRange | undefined {
	if (
		fn.instructionKind(instruction) !== "operation" ||
		fn.instructionOpcodeName(instruction) !== "loadPropertyStatic"
	)
		return undefined;
	const attributes = fn.instructionAttributes(instruction);
	const key = attributes.stringIndex;
	if (
		typeof key !== "number" ||
		program.stringConstants[key]?.length !== 6 ||
		program.stringConstantText(key) !== "length"
	)
		return undefined;
	if (attributes.exactArrayLength === true) return COMPILER_UINT32_RANGE;
	if (attributes.primitiveStringLength === true) return COMPILER_STRING_LENGTH_RANGE;
	const receiver = fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction));
	const mask = kinds?.kindMask(receiver) ?? COMPILER_VALUE_KIND_TOP;
	// Nullish receivers throw; only the String alternative contributes normal lengths.
	return (mask & COMPILER_VALUE_KIND_STRING) !== 0 &&
		(mask & ~(COMPILER_VALUE_KIND_STRING | COMPILER_VALUE_KIND_NULLISH)) === 0
		? COMPILER_STRING_LENGTH_RANGE
		: undefined;
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
		case "loadArgumentCount":
		case "mathUnaryNumber":
		case "mathBinaryNumber":
		case "preparedStringCompare":
		case "preciseNumberSum":
		case "stringConcatLength":
			return COMPILER_VALUE_KIND_NUMBER;
		case "createString":
		case "concatStrings":
			return COMPILER_VALUE_KIND_STRING;
		case "createBigint":
			return COMPILER_VALUE_KIND_BIGINT;
		case "createPrivateName":
		case "createPrivateNames":
			return COMPILER_VALUE_KIND_SYMBOL;
		case "createFunction":
		case "createArray":
		case "createArrayFromIterable":
		case "baseConstructResult":
		case "createBaseConstructReceiver":
		case "createObject":
		case "createObjectShaped":
		case "createModuleNamespace":
		case "createTemplateObject":
		case "instantiateLiteralTemplate":
			return COMPILER_VALUE_KIND_OBJECT;
		case "deleteProperty":
		case "forInHas":
		case "guardBaseConstructorLayout":
		case "isEmpty":
		case "typeofCompare":
			return COMPILER_VALUE_KIND_BOOLEAN;
		default:
			return undefined;
	}
}

function declaredValueKind(fn: CoreFunctionStore, value: CoreValueId): number {
	const representation = representationKind(fn, value);
	if (representation !== undefined) return representation;
	const definition = coreReturnedValueDefinition(fn, value);
	if (definition === undefined) return COMPILER_VALUE_KIND_TOP;
	const opcode = fn.instructionOpcodeName(definition);
	const operator = fn.instructionAttributes(definition).operator;
	return (
		staticOpcodeKind(opcode) ??
		((opcode === "unary" || opcode === "binary") && typeof operator === "string"
			? compilerOperatorFixedResultKind(opcode, operator)
			: undefined) ??
		COMPILER_VALUE_KIND_TOP
	);
}

const KIND_TRANSFER_JOIN = 1;
const KIND_TRANSFER_COPY = 2;
const KIND_TRANSFER_NUMERIC_UNARY = 3;
const KIND_TRANSFER_BINARY = 4;
const KIND_TRANSFER_ADD = 5;
const KIND_TRANSFER_ELEMENT = 6;
const KIND_TRANSFER_TYPED_ELEMENT = 7;
const KIND_TRANSFER_PROPERTY_KEY = 8;
const KIND_TRANSFER_NORMAL_RESULT_JOIN = 9;
const KIND_TRANSFER_STRING_LENGTH = 10;

// A non-number key on an Array whose holders are all known reads its length, a
// prototype member or nothing, since no one gave it other named properties.
const NAMED_ARRAY_PROPERTY_KINDS =
	COMPILER_VALUE_KIND_NUMBER | COMPILER_VALUE_KIND_OBJECT | COMPILER_VALUE_KIND_UNDEFINED;

function transferredKind(
	kind: number,
	constant: number,
	inputs: ArrayLike<number>,
	start: number,
	count: number,
	mask: (value: CoreValueId, point?: CoreControlPoint) => number,
	inputPoints?: ReadonlyArray<CoreControlPoint | undefined>,
): number {
	if (kind === KIND_TRANSFER_JOIN || kind === KIND_TRANSFER_NORMAL_RESULT_JOIN) {
		for (let index = 0; index < count; index++)
			constant |= mask(
				inputs[start + index]! as CoreValueId,
				kind === KIND_TRANSFER_NORMAL_RESULT_JOIN
					? inputPoints?.[start + index]
					: undefined,
			);
		return constant;
	}
	const left = mask(inputs[start]! as CoreValueId);
	if (kind === KIND_TRANSFER_COPY) return left;
	if (kind === KIND_TRANSFER_STRING_LENGTH) {
		// Nullish receivers throw before producing a result; primitive String length is immutable.
		if ((left & ~(COMPILER_VALUE_KIND_STRING | COMPILER_VALUE_KIND_NULLISH)) !== 0)
			return constant;
		return (left & COMPILER_VALUE_KIND_STRING) !== 0
			? constant & COMPILER_VALUE_KIND_NUMBER
			: 0;
	}
	// Compact index keys retain Number storage; only existing Strings and Symbols preserve their kind.
	if (kind === KIND_TRANSFER_PROPERTY_KEY)
		return (left & ~(COMPILER_VALUE_KIND_STRING | COMPILER_VALUE_KIND_SYMBOL)) === 0
			? left
			: COMPILER_VALUE_KIND_TOP;
	if (kind === KIND_TRANSFER_ELEMENT)
		return (left & ~COMPILER_VALUE_KIND_NUMBER) === 0
			? constant
			: constant | NAMED_ARRAY_PROPERTY_KINDS;
	// A Number key always takes the integer-indexed path, which never reads the prototype.
	if (kind === KIND_TRANSFER_TYPED_ELEMENT)
		return (left & ~COMPILER_VALUE_KIND_NUMBER) === 0
			? constant
			: COMPILER_VALUE_KIND_TOP;
	if (kind === KIND_TRANSFER_NUMERIC_UNARY)
		return compilerNumericResultKind("unary", left);
	const right = mask(inputs[start + 1]! as CoreValueId);
	return compilerNumericResultKind(
		kind === KIND_TRANSFER_BINARY ? "binary" : "add",
		left,
		right,
	);
}

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
	options: {
		readonly numberValue?: (value: CoreValueId) => boolean;
		readonly contents?: "numeric" | "unknown";
	} = {},
): ReadonlyArray<CorePrivateArrayUseSummary> {
	if (seeds.length === 0) return [];
	const numberValue = options.numberValue ?? ((value) => isNumberValue(fn, value));
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
				(options.contents === "unknown" ||
					numberValue(fn.kernel.operandAt(operandStart + 2)))
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
	let roots: ReadonlyMap<CoreValueId, CoreValueId> | undefined;
	for (const instruction of fn.instructionIds()) {
		if (fn.instructionKind(instruction) !== "operation") continue;
		const opcode = fn.instructionOpcodeName(instruction);
		if (
			opcode !== "call" &&
			(opcode !== "callKnown" ||
				fn.instructionAttributes(instruction).operation !== "Array.from")
		)
			continue;
		roots ??= coreCanonicalValueRoots(fn, cfg);
		const result = coreExactArrayFromCallResult(program, fn, roots, context, instruction);
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
	return privateArrayUses(
		program,
		fn,
		cfg,
		[
			...privateNumericArraySeeds(fn),
			...privateArrayFromSeeds(program, fn, cfg, context),
		],
		{ contents: "unknown" },
	);
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
	return new Set(
		corePrivatePackedRestArrays(program, fn, () => cfg, context, numberValue).flatMap(
			(array) => array.elementLoads,
		),
	);
}

export function corePrivatePackedRestArrays(
	program: CoreProgram,
	fn: CoreFunctionStore,
	control: () => CoreControlFlow,
	context: CoreCompilationContext,
	numberValue: (value: CoreValueId) => boolean,
): ReadonlyArray<CorePrivateArrayUseSummary> {
	if (!privateArrayPolicyIsLocked(context)) return [];
	const seeds = privatePackedRestArraySeeds(fn);
	if (seeds.length === 0) return [];
	return privateArrayUses(program, fn, control(), seeds, {
		numberValue,
	}).filter((array) => array.elementStores.length === 0);
}

interface KindTransferBuffer {
	inputPoints?: Array<CoreControlPoint | undefined>;
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
	program: CoreProgram,
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
	if (
		opcode === "loadPropertyStatic" &&
		(fn.instructionAttributes(instruction).exactArrayLength === true ||
			fn.instructionAttributes(instruction).primitiveStringLength === true)
	) {
		masks[output] = masks[output]! | COMPILER_VALUE_KIND_NUMBER;
		return;
	}
	if (
		opcode === "construct" ||
		opcode === "constructSpread" ||
		(opcode === "callKnown" && fn.instructionAttributes(instruction).construct === true)
	) {
		masks[output] = masks[output]! | COMPILER_VALUE_KIND_OBJECT;
		return;
	}
	if (opcode === "loadThis" && inputs?.receiverMask !== undefined) {
		masks[output] = masks[output]! | inputs.receiverMask;
		return;
	}
	const callMask = callResultKind(fn, instruction) ?? recordFieldKind(fn, instruction);
	const contextual = inputs?.operationResultMask?.(instruction, output);
	const alternatives = inputs?.operationResultAlternatives?.(instruction, output);
	if (contextual !== undefined && alternatives !== undefined) {
		// Stored alternatives cannot execute before the record producer completes.
		if (!alternatives.hasNormalResult) return;
		// Recompute the complete flow before publishing a new normal-result bound.
		const index = buffer.kinds.length;
		addKindTransfer(buffer, KIND_TRANSFER_NORMAL_RESULT_JOIN, output, contextual);
		buffer.inputCounts[index] = alternatives.values.length;
		for (const alternative of alternatives.values) {
			(buffer.inputPoints ??= [])[buffer.inputs.length] =
				alternative.edge ?? fn.instructionBlock(alternative.instruction);
			buffer.inputs.push(alternative.value);
		}
		return;
	}
	// Published field bounds are outputs of this flow and cannot seed it after edits.
	const supplied =
		contextual !== undefined &&
		(opcode === "loadProperty" || opcode === "loadPropertyStatic")
			? contextual
			: callMask === undefined
				? contextual
				: contextual === undefined
					? callMask
					: callMask & contextual;
	if (opcode === "loadPropertyStatic") {
		const index = fn.instructionAttributes(instruction).stringIndex;
		if (
			typeof index === "number" &&
			program.stringConstants[index]?.length === 6 &&
			program.stringConstantText(index) === "length"
		) {
			addKindTransfer(
				buffer,
				KIND_TRANSFER_STRING_LENGTH,
				output,
				supplied ?? COMPILER_VALUE_KIND_TOP,
				[fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction))],
			);
			return;
		}
	}
	if (supplied !== undefined) {
		masks[output] = masks[output]! | supplied;
		return;
	}
	const elements = inputs?.elementLoadMask?.(instruction);
	if (elements !== undefined) {
		addKindTransfer(buffer, KIND_TRANSFER_ELEMENT, output, elements, [
			fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction) + 1),
		]);
		return;
	}
	const typedElements = inputs?.typedElementLoadMask?.(instruction);
	if (typedElements !== undefined) {
		addKindTransfer(buffer, KIND_TRANSFER_TYPED_ELEMENT, output, typedElements, [
			fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction) + 1),
		]);
		return;
	}
	if (opcode === "callKnown") {
		const attributes = fn.instructionAttributes(instruction);
		const mask =
			!attributes.construct && typeof attributes.operation === "string"
				? builtinNormalResultKinds(attributes.operation)
				: undefined;
		if (mask !== undefined) {
			masks[output] = masks[output]! | mask;
			return;
		}
		const projection = coreBuiltinResultProjection(fn, instruction);
		if (projection !== undefined && projection.identityKinds === undefined) {
			if (projection.input === undefined)
				masks[output] = masks[output]! | COMPILER_VALUE_KIND_UNDEFINED;
			else addKindTransfer(buffer, KIND_TRANSFER_COPY, output, 0, [projection.input]);
			return;
		}
	}
	const forwarded = inputs?.operationResultValue?.(instruction, output);
	if (forwarded !== undefined) {
		addKindTransfer(buffer, KIND_TRANSFER_COPY, output, 0, [forwarded]);
		return;
	}
	const operandCount = fn.kernel.instructionOperandCount(instruction);
	if (opcode === "toPropertyKey" && operandCount === 2) {
		addKindTransfer(buffer, KIND_TRANSFER_PROPERTY_KEY, output, 0, [
			fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction) + 1),
		]);
		return;
	}
	if (opcode === "move" && operandCount === 1) {
		addOperationKindTransfer(buffer, KIND_TRANSFER_COPY, output, fn, instruction);
		return;
	}
	const operator =
		opcode === "unary" || opcode === "binary"
			? fn.instructionAttributes(instruction).operator
			: undefined;
	if (opcode === "unary" && operandCount === 1 && typeof operator === "string") {
		const constant = compilerOperatorFixedResultKind(opcode, operator);
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
		if (
			compilerOperatorFixedResultKind(opcode, operator) === COMPILER_VALUE_KIND_BOOLEAN
		) {
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

const INTEGER_PROOF_EXACT = -1;
const INTEGER_PROOF_VISITING = -2;

function valueKindSnapshot(
	masks: Uint16Array,
	integerRecipes: Int32Array,
	joinInputs: Uint32Array,
	runOwner?: CoreOptimizationOwnerRunner,
	onIntegerWork?: (values: number) => void,
): CoreValueKindAnalysis {
	let integerQueries = 0,
		integerValues = 0;
	const mask = (value: CoreValueId) => masks[value] ?? 0;
	const scalarKind = (
		value: CoreValueId,
	): Exclude<CoreExactScalarKind, "int32"> | undefined => {
		const kind = mask(value);
		if (kind === COMPILER_VALUE_KIND_NUMBER) return "number";
		if (kind === COMPILER_VALUE_KIND_BOOLEAN) return "boolean";
		if (kind === COMPILER_VALUE_KIND_STRING) return "string";
		return undefined;
	};
	const proveInteger = (value: CoreValueId): boolean => {
		const stack: Array<{
			value: CoreValueId;
			recipe: number;
			next: number;
			end: number;
		}> = [];
		const push = (value: CoreValueId) => {
			const recipe = integerRecipes[value]!;
			// Positive recipes forward one value; negative offsets address packed [count, ...inputs].
			const offset = recipe > 0 ? 0 : -recipe - 3;
			stack.push({
				value,
				recipe,
				next: recipe > 0 ? 0 : offset + 1,
				end: recipe > 0 ? 1 : offset + 1 + joinInputs[offset]!,
			});
			integerRecipes[value] = INTEGER_PROOF_VISITING;
			integerValues++;
		};
		push(value);
		while (stack.length > 0) {
			const current = stack[stack.length - 1]!;
			if (current.next === current.end) {
				integerRecipes[current.value] = INTEGER_PROOF_EXACT;
				stack.pop();
				continue;
			}
			const input = (
				current.recipe > 0 ? current.recipe - 1 : joinInputs[current.next]!
			) as CoreValueId;
			const recipe = integerRecipes[input] ?? 0;
			if (recipe === INTEGER_PROOF_EXACT) {
				current.next++;
			} else if (recipe === 0 || recipe === INTEGER_PROOF_VISITING) {
				// An unseeded cycle stays false in the least fixed point, even with integer entry edges.
				integerRecipes[current.value] = 0;
				stack.pop();
			} else {
				push(input);
			}
		}
		return integerRecipes[value] === INTEGER_PROOF_EXACT;
	};
	return Object.freeze({
		statistics: Object.freeze({
			get integerQueries() {
				return integerQueries;
			},
			get integerValues() {
				return integerValues;
			},
			integerSnapshotBytes: integerRecipes.byteLength + joinInputs.byteLength,
		}),
		kindMask(value: CoreValueId) {
			return mask(value) || COMPILER_VALUE_KIND_TOP;
		},
		latticeMask: mask,
		scalarKind,
		exactScalar(value: CoreValueId) {
			const kind = scalarKind(value);
			if (kind !== "number") return kind;
			integerQueries++;
			const recipe = integerRecipes[value]!;
			if (recipe === INTEGER_PROOF_EXACT) return "int32";
			if (recipe === 0) return "number";
			const before = integerValues;
			const exact =
				runOwner === undefined
					? proveInteger(value)
					: runOwner(CORE_OPTIMIZATION_OWNER.localValueKinds, () => proveInteger(value));
			onIntegerWork?.(integerValues - before);
			return exact ? "int32" : "number";
		},
	});
}

function solveCoreValueKinds(
	program: CoreProgram,
	fn: CoreFunctionStore,
	cfg: CoreControlFlow,
	inputs?: CoreValueKindInputs,
	demandedValues?: ReadonlyArray<CoreValueId>,
) {
	const masks = new Uint16Array(fn.valueCapacity);
	const integerRecipes = new Int32Array(
		demandedValues === undefined ? fn.valueCapacity : 0,
	);
	const numericIntegerSeeds: Array<CoreValueId> = [];
	const joinInputs: Array<number> = [];
	const integerJoin = (values: ReadonlyArray<CoreValueId>): number => {
		if (values.length === 0) return 0;
		if (values.length === 1) return values[0]! + 1;
		const recipe = -joinInputs.length - 3;
		joinInputs.push(values.length);
		for (const value of values) joinInputs.push(value);
		return recipe;
	};
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
	const filteredIncoming = new Map<CoreBlockId, ReadonlyArray<CoreControlEdge>>();
	const addParameter = (block: CoreBlockId, index: number): void => {
		let incoming = filteredIncoming.get(block);
		if (incoming === undefined) {
			// A no-throw proof can retire a catch edge before its outgoing edges are removed.
			incoming = (cfg.predecessors[block] ?? []).filter(
				(edge) =>
					cfg.reachable.has(edge.from) &&
					(inputs?.controlEdges === undefined || inputs.controlEdges.has(edge)),
			);
			filteredIncoming.set(block, incoming);
		}
		const parameterStart = fn.kernel.blockParameterStart(block);
		const row = parameterStart + index;
		const parameter = fn.kernel.blockParameterValue(row);
		const representation = representationKind(fn, parameter);
		if (demandedValues === undefined && fn.valueRepresentation(parameter) === "i32")
			integerRecipes[parameter] = INTEGER_PROOF_EXACT;
		const formalIndex = formalParameters[parameter]!;
		const boundary =
			formalIndex >= 0 ||
			fn.kernel.blockParameterRole(row) === 1 ||
			incoming.length === 0;
		let incomingValues: Array<CoreValueId> | undefined;
		if (
			!boundary &&
			(representation === undefined ||
				(demandedValues === undefined && representation === COMPILER_VALUE_KIND_NUMBER))
		) {
			incomingValues = [];
			for (const edge of incoming) {
				const value = edge.arguments[edge.kind === "exceptional" ? index - 1 : index];
				if (value !== undefined) incomingValues.push(value);
			}
			if (
				demandedValues === undefined &&
				representation === COMPILER_VALUE_KIND_NUMBER &&
				fn.valueRepresentation(parameter) !== "i32"
			)
				integerRecipes[parameter] = integerJoin(incomingValues);
		}
		if (representation !== undefined || boundary) {
			const kind =
				representation ??
				(formalIndex < 0
					? COMPILER_VALUE_KIND_TOP
					: (inputs?.parameterMasks?.[formalIndex] ?? COMPILER_VALUE_KIND_TOP));
			masks[parameter] = masks[parameter]! | kind;
			return;
		}
		addKindTransfer(transfers, KIND_TRANSFER_JOIN, parameter, 0, incomingValues);
	};
	const addOutput = (instruction: CoreInstructionId, output: CoreValueId): void => {
		addOperationTransfer(program, transfers, masks, fn, instruction, output, inputs);
		if (demandedValues !== undefined) return;
		const opcode = fn.instructionOpcodeName(instruction);
		const attributes = fn.instructionAttributes(instruction);
		const operator = attributes.operator;
		const preservedInput =
			opcode === "mathUnaryNumber" || opcode === "callKnown"
				? coreIntegerPreservedResultInput(fn, instruction)
				: undefined;
		if (
			fn.valueRepresentation(output) === "i32" ||
			compilerIntegerRangeIsInt32(coreInstructionResultIntegerRange(fn, instruction)) ||
			((opcode === "createNumber" || opcode === "createF64") &&
				numberIsExactInt32(attributes.value)) ||
			(opcode === "callKnown" &&
				!attributes.construct &&
				typeof attributes.operation === "string" &&
				builtinResultIsInt32(attributes.operation))
		) {
			integerRecipes[output] = INTEGER_PROOF_EXACT;
		} else if (preservedInput !== undefined) {
			integerRecipes[output] = preservedInput + 1;
		} else if (opcode === "move" && fn.valueRepresentation(output) === "f64") {
			integerRecipes[output] =
				fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction)) + 1;
		} else if (
			(opcode === "unary" && operator === "~") ||
			(opcode === "binary" &&
				typeof operator === "string" &&
				SIGNED_INT32_BINARY_OPERATORS.has(operator))
		) {
			numericIntegerSeeds.push(output);
		}
	};
	const computed =
		demandedValues === undefined ? undefined : new Uint8Array(fn.valueCapacity);
	if (computed !== undefined) {
		const pending = [...demandedValues!];
		for (let cursor = 0; cursor < pending.length; cursor++) {
			const value = pending[cursor]!;
			if (computed[value] !== 0) continue;
			computed[value] = 1;
			const inputStart = transfers.inputs.length;
			const owner = fn.kernel.valueDefinitionOwner(value);
			if (fn.kernel.valueDefinitionKind(value) === 0)
				addParameter(owner as CoreBlockId, fn.kernel.valueDefinitionIndex(value));
			else addOutput(coreInstructionId(owner), value);
			for (let index = inputStart; index < transfers.inputs.length; index++)
				pending.push(transfers.inputs[index]!);
		}
	} else
		for (let blockIndex = 0; blockIndex < fn.blockCapacity; blockIndex++) {
			const block = blockIndex as CoreBlockId;
			if (fn.kernel.blockLive(block) === 0) continue;
			for (let index = 0; index < fn.kernel.blockParameterCount(block); index++)
				addParameter(block, index);
			for (
				let instructionIndex = fn.kernel.blockFirstInstruction(block);
				instructionIndex >= 0;
				instructionIndex = fn.kernel.instructionNext(
					instructionIndex as CoreInstructionId,
				)
			) {
				const instruction = instructionIndex as CoreInstructionId;
				if (fn.kernel.instructionOpcode(instruction) < 0) continue;
				const resultStart = fn.kernel.instructionResultStart(instruction);
				const resultCount = fn.kernel.instructionResultCount(instruction);
				for (let index = 0; index < resultCount; index++) {
					const output = fn.kernel.resultAt(resultStart + index);
					addOutput(instruction, output);
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
	let conditional: CoreConditionalValueKinds | undefined;

	const mask = (value: CoreValueId, point?: CoreControlPoint): number => {
		const kind = masks[value] ?? 0;
		if (point === undefined || kind === 0) return kind;
		const declared = declaredValueKind(fn, value);
		if ((declared & (declared - 1)) === 0) return kind;
		// Structural bounds stay fixed while the value lattice grows, including through recursive fields.
		return (
			kind &
			(conditional ??= analyzeCoreConditionalValueKinds(program, fn, cfg, (value) =>
				declaredValueKind(fn, value),
			)).kindMask(value, point)
		);
	};
	const wakeDependents = (
		value: CoreValueId,
		queued: Uint8Array,
		queue: Array<number>,
	): void => {
		for (let dependency = dependentHeads[value]!; dependency >= 0;) {
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
		const incoming = transferredKind(
			transferKinds[index]!,
			transferConstants[index]!,
			transferInputs,
			transferInputStarts[index]!,
			transferInputCounts[index]!,
			mask,
			transfers.inputPoints,
		);
		const next = masks[output]! | incoming;
		if (next === masks[output]) continue;
		masks[output] = next;
		wakeDependents(output, queued, queue);
	}
	for (const value of numericIntegerSeeds)
		if (masks[value] === COMPILER_VALUE_KIND_NUMBER)
			integerRecipes[value] = INTEGER_PROOF_EXACT;
	for (
		let index = 0;
		demandedValues === undefined && index < transferOutputs.length;
		index++
	) {
		const output = transferOutputs[index]! as CoreValueId;
		const kind = transferKinds[index]!;
		if (
			masks[output] !== COMPILER_VALUE_KIND_NUMBER ||
			integerRecipes[output] !== 0 ||
			(kind !== KIND_TRANSFER_JOIN && kind !== KIND_TRANSFER_COPY)
		)
			continue;
		const definitionKind = fn.kernel.valueDefinitionKind(output);
		if (
			definitionKind !== 0 &&
			(definitionKind !== 1 ||
				fn.instructionOpcodeName(
					coreInstructionId(fn.kernel.valueDefinitionOwner(output)),
				) !== "move")
		)
			continue;
		const start = transferInputStarts[index]!,
			count = transferInputCounts[index]!;
		if (count === 1) integerRecipes[output] = transferInputs[start]! + 1;
		else if (count > 1) {
			integerRecipes[output] = -joinInputs.length - 3;
			joinInputs.push(count);
			for (let offset = 0; offset < count; offset++)
				joinInputs.push(transferInputs[start + offset]!);
		}
	}
	return {
		masks,
		integerRecipes,
		joinInputs: Uint32Array.from(joinInputs),
		computed,
	};
}

export function analyzeCoreValueKinds(
	program: CoreProgram,
	fn: CoreFunctionStore,
	cfg: CoreControlFlow,
	inputs?: CoreValueKindInputs,
): CoreValueKindAnalysis {
	const { masks, integerRecipes, joinInputs } = solveCoreValueKinds(
		program,
		fn,
		cfg,
		inputs,
	);
	return valueKindSnapshot(
		masks,
		integerRecipes,
		joinInputs,
		inputs?.runOwner,
		inputs?.onIntegerWork,
	);
}

function integerWorkRecorder(
	recordResult: ((result: unknown) => void) | undefined,
): ((values: number) => void) | undefined {
	return recordResult === undefined
		? undefined
		: (values) => recordResult({ integerValues: values });
}

export const CORE_LOCAL_VALUE_KIND_ANALYSIS: CoreAnalysisDefinition<CoreValueKindAnalysis> =
	{
		key: "local-value-kinds",
		scope: "function",
		owner: CORE_OPTIMIZATION_OWNER.localValueKinds,
		functionDependencies: [
			"body",
			"cfg",
			"exceptionFlow",
			"memoryEffects",
			"normalResults",
			"representations",
		],
		contextIdentity: (context) => context,
		compute({ program, context, request, get, runOwner, recordResult }) {
			if (request.scope !== "function") throw new Error("Expected function analysis");
			const fn = program.function(request.function);
			const cfg = get(CORE_CONTROL_FLOW_BUNDLE_ANALYSIS, request).exceptional();
			let numericArrayLoads: ReadonlySet<CoreInstructionId> | undefined;
			const fields = corePrivateFieldFacts(program);
			const elementLoadMask =
				fields === undefined
					? undefined
					: (instruction: CoreInstructionId) => fields.elementMask(fn, instruction);
			// Memory planning records the receiver's exact TypedArray kind on the load itself.
			const typedElementLoadMask = (instruction: CoreInstructionId) =>
				fn.instructionOpcodeName(instruction) === "loadProperty" &&
				coreNumericTypedArrayKind(
					fn.instructionAttributes(instruction)[CORE_EXACT_TYPED_ARRAY_KIND_ATTRIBUTE],
				) !== undefined
					? COMPILER_VALUE_KIND_NUMBER | COMPILER_VALUE_KIND_UNDEFINED
					: undefined;
			const operationResultMask = (instruction: CoreInstructionId) => {
				const opcode = fn.instructionOpcodeName(instruction);
				if (opcode === "loadPrivate") return fields?.readMask(fn, instruction);
				if (opcode !== "loadProperty") return undefined;
				return (numericArrayLoads ??= corePrivateNumericArrayLoads(
					program,
					fn,
					cfg,
					context,
				)).has(instruction)
					? COMPILER_VALUE_KIND_NUMBER | COMPILER_VALUE_KIND_UNDEFINED
					: undefined;
			};
			if (context.data.singleAssignmentGlobalSlots.length === 0) {
				return analyzeCoreValueKinds(program, fn, cfg, {
					operationResultMask,
					elementLoadMask,
					typedElementLoadMask,
					runOwner,
					onIntegerWork: integerWorkRecorder(recordResult),
				});
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
			let storesIndexed = false;
			const indexStores = () => {
				if (storesIndexed) return;
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
				storesIndexed = true;
			};
			let instructionOrder: Int32Array | undefined;
			const getInstructionOrder = (): Int32Array => {
				if (instructionOrder !== undefined) return instructionOrder;
				const positions = new Int32Array(fn.instructionCapacity);
				positions.fill(-1);
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
						positions[instructionIndex] = order++;
					}
				}
				return (instructionOrder = positions);
			};
			const operationResultValue = (
				instruction: CoreInstructionId,
			): CoreValueId | undefined => {
				if (fn.instructionOpcodeName(instruction) !== "loadGlobal") return undefined;
				const index = fn.instructionAttributes(instruction).index;
				if (typeof index !== "number" || !closedGlobals.has(index)) return undefined;
				indexStores();
				const store = stores.get(index);
				if (store === undefined || store === null) return undefined;
				const storeBlock = fn.instructionBlock(store.instruction);
				const loadBlock = fn.instructionBlock(instruction);
				const dominates =
					storeBlock === loadBlock
						? getInstructionOrder()[store.instruction]! <
							getInstructionOrder()[instruction]!
						: cfg.instructionDominatesBlock(storeBlock, loadBlock);
				return dominates ? store.value : undefined;
			};
			return analyzeCoreValueKinds(program, fn, cfg, {
				operationResultMask,
				elementLoadMask,
				typedElementLoadMask,
				operationResultValue,
				runOwner,
				onIntegerWork: integerWorkRecorder(recordResult),
			});
		},
	};

export type CoreProgramValueKindSummary = CoreProgramFlowValueKindSummary;
export type CoreProgramValueKindStatistics = CoreProgramFlowValueKindStatistics;
export interface CoreProgramFunctionValueKinds extends Pick<
	CoreValueKindAnalysis,
	"kindMask"
> {
	latticeMask(
		this: void,
		value: CoreValueId,
		point?: CoreControlPoint,
	): CompilerValueKindMask;
}
export type CoreProgramValueKinds =
	CoreProgramFlowValueKinds<CoreProgramFunctionValueKinds>;
export type CoreProgramValueKindState = CoreProgramFlowValueKindState<
	CoreProgramFunctionValueKinds,
	CoreCallGraphIndex
>;

export const CORE_PROGRAM_FLOW_VALUE_KIND_SEMANTICS: CoreProgramFlowValueKindSemantics<CoreProgramFunctionValueKinds> =
	Object.freeze({
		observationValues(program: CoreProgram, fn: CoreFunctionStore) {
			const values = new Set<CoreValueId>(coreRecordReturnKindInputs(fn));
			for (const instruction of fn.instructionIds())
				coreValueKindObservation(program, fn, instruction, (value) => {
					values.add(value);
					return COMPILER_VALUE_KIND_TOP;
				});
			return [...values];
		},
		analyze(
			program: CoreProgram,
			fn: CoreFunctionStore,
			cfg: CoreControlFlow,
			inputs: CoreProgramFlowValueKindInputs,
		) {
			const fields = corePrivateFieldFacts(program);
			const { masks, computed } = solveCoreValueKinds(
				program,
				fn,
				cfg,
				fields === undefined
					? inputs
					: {
							...inputs,
							operationResultMask: (instruction, result) =>
								inputs.operationResultMask?.(instruction, result) ??
								fields.readMask(fn, instruction),
							elementLoadMask: (instruction) =>
								inputs.elementLoadMask?.(instruction) ??
								fields.elementMask(fn, instruction),
						},
				inputs.demandedValues,
			);
			const mask = (value: CoreValueId): number => {
				if (computed![value] !== 1)
					throw new Error(`Unrequested program value kind ${value}`);
				return masks[value]!;
			};
			let conditional: CoreConditionalValueKinds | undefined;
			return Object.freeze({
				kindMask: (value: CoreValueId) => mask(value) || COMPILER_VALUE_KIND_TOP,
				latticeMask(value: CoreValueId, point?: CoreControlPoint) {
					const kind = mask(value);
					// An unsolved value cannot acquire a normal result from a branch restriction.
					if (point === undefined || (kind & (kind - 1)) === 0) return kind;
					return (conditional ??= analyzeCoreConditionalValueKinds(
						program,
						fn,
						cfg,
						(value) => (computed![value] === 1 ? masks[value]! : COMPILER_VALUE_KIND_TOP),
					)).kindMask(value, point);
				},
			});
		},
		latticeMask(analysis: CoreProgramFunctionValueKinds, value: CoreValueId) {
			return analysis.latticeMask(value);
		},
		recordReads(fn: CoreFunctionStore, control: () => CoreControlFlow) {
			return coreRecordFieldReads(fn, control);
		},
		returnRecord(
			_program: CoreProgram,
			fn: CoreFunctionStore,
			control: CoreControlFlow,
			analysis: CoreProgramFunctionValueKinds,
			call: (instruction: CoreInstructionId) => CoreRecordValueKind,
		) {
			return coreReturnedRecordKinds(
				fn,
				control,
				(value, consumer, edge) =>
					analysis.latticeMask(
						value,
						edge ?? (consumer === undefined ? undefined : fn.instructionBlock(consumer)),
					),
				call,
			);
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

// Undefined requests propagation; a fixed TOP means propagation cannot refine the value.
export function coreValueKindDemand(
	program: CoreProgram,
	fn: CoreFunctionStore,
	control: () => CoreControlFlow,
	targets: CoreCallGraphIndex,
	externallyReachable: boolean,
): (value: CoreValueId) => CompilerValueKindMask | undefined {
	const fixed = new Map<CoreValueId, CompilerValueKindMask | undefined>();
	const visiting = new Set<CoreValueId>();
	const masks = new Uint16Array(fn.valueCapacity);
	const transfers: KindTransferBuffer = {
		kinds: [],
		outputs: [],
		constants: [],
		inputStarts: [],
		inputCounts: [],
		inputs: [],
	};
	let recordReads: ReturnType<typeof coreRecordFieldReads> | undefined;
	const parameters = new Set<CoreValueId>();
	for (let index = 0; index < fn.parameterCount; index++)
		parameters.add(fn.kernel.functionParameter(index));
	const stack: Array<{ value: CoreValueId; transfer: number; next: number }> = [];
	const push = (value: CoreValueId): void => {
		const representation = representationKind(fn, value);
		if (representation !== undefined) {
			fixed.set(value, representation);
			return;
		}
		const transfer = transfers.outputs.length;
		const definitionKind = fn.kernel.valueDefinitionKind(value);
		if (definitionKind === 0) {
			if (parameters.has(value)) {
				fixed.set(value, externallyReachable ? COMPILER_VALUE_KIND_TOP : undefined);
				return;
			}
			const block = fn.kernel.valueDefinitionOwner(value) as CoreBlockId;
			const index = fn.kernel.valueDefinitionIndex(value);
			const row = fn.kernel.blockParameterStart(block) + index;
			if (fn.kernel.blockParameterRole(row) === 1) {
				fixed.set(value, COMPILER_VALUE_KIND_TOP);
				return;
			}
			const cfg = control();
			const incoming = (cfg.predecessors[block] ?? []).filter((edge) =>
				cfg.reachable.has(edge.from),
			);
			if (incoming.length === 0) {
				fixed.set(value, COMPILER_VALUE_KIND_TOP);
				return;
			}
			const values: Array<CoreValueId> = [];
			for (const edge of incoming) {
				const input = edge.arguments[edge.kind === "exceptional" ? index - 1 : index];
				if (input !== undefined) values.push(input);
			}
			addKindTransfer(transfers, KIND_TRANSFER_JOIN, value, 0, values);
		} else if (definitionKind === 1) {
			const instruction = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
			let demand = false;
			addOperationTransfer(program, transfers, masks, fn, instruction, value, {
				operationResultMask(instruction) {
					const callKind =
						callResultKind(fn, instruction) ?? recordFieldKind(fn, instruction);
					if (callKind !== undefined) return callKind;
					if (fn.instructionOpcodeName(instruction) === "loadThis") {
						demand = !externallyReachable;
						return COMPILER_VALUE_KIND_TOP;
					}
					const read =
						fn.instructionOpcodeName(instruction) === "loadPropertyStatic" ||
						fn.instructionOpcodeName(instruction) === "loadProperty"
							? (recordReads ??= coreRecordFieldReads(fn, control)).get(instruction)
							: undefined;
					if (read !== undefined) {
						demand = read.producers.every((producer) => {
							const site = targets.site(fn.id, producer);
							return (
								site !== undefined &&
								!site.targets.opaque &&
								(site.targets.anyScript
									? targets.sourceClosed
									: site.targets.functions.length > 0)
							);
						});
						return COMPILER_VALUE_KIND_TOP;
					}
					const site = targets.site(fn.id, instruction);
					if (site === undefined) return undefined;
					demand =
						!site.targets.opaque &&
						(site.targets.anyScript
							? targets.sourceClosed
							: site.targets.functions.length > 0);
					return COMPILER_VALUE_KIND_TOP;
				},
			});
			if (demand || transfer === transfers.outputs.length) {
				fixed.set(value, demand ? undefined : masks[value]!);
				return;
			}
		} else {
			fixed.set(value, undefined);
			return;
		}
		visiting.add(value);
		stack.push({ value, transfer, next: 0 });
	};
	return (value) => {
		if (!fixed.has(value)) push(value);
		while (stack.length > 0) {
			const frame = stack[stack.length - 1]!;
			const start = transfers.inputStarts[frame.transfer]!;
			const count = transfers.inputCounts[frame.transfer]!;
			if (!fixed.has(frame.value) && frame.next < count) {
				const input = transfers.inputs[start + frame.next]!;
				if (!fixed.has(input)) {
					if (visiting.has(input)) fixed.set(input, undefined);
					else push(input);
					continue;
				}
				if (fixed.get(input) === undefined) fixed.set(frame.value, undefined);
				else frame.next++;
				continue;
			}
			if (!fixed.has(frame.value))
				fixed.set(
					frame.value,
					transferredKind(
						transfers.kinds[frame.transfer]!,
						transfers.constants[frame.transfer]!,
						transfers.inputs,
						start,
						count,
						(input) => fixed.get(input)!,
					),
				);
			visiting.delete(frame.value);
			stack.pop();
		}
		const result = fixed.get(value);
		return result === undefined ? undefined : result || COMPILER_VALUE_KIND_TOP;
	};
}

function coreTypeofComparison(
	mask: CompilerValueKindMask,
	expected: string,
): boolean | undefined {
	switch (expected) {
		case "undefined":
		case "object":
		case "boolean":
		case "number":
		case "string":
		case "symbol":
		case "bigint":
		case "function":
			return compilerTypeofComparison(mask, expected);
		default:
			return false;
	}
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
	return units === undefined ? undefined : program.stringConstantText(stringIndex);
}

export function coreValueKindObservation(
	program: CoreProgram,
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	kindMask: (value: CoreValueId) => CompilerValueKindMask,
	integerRange?: (
		value: CoreValueId,
		consumer: CoreInstructionId,
	) => CompilerIntegerRange | undefined,
	identity?: (value: CoreValueId) => CoreValueId,
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
		const equal = coreTypeofComparison(kindMask(input), expected);
		return equal === undefined
			? undefined
			: fn.instructionAttributes(instruction).negated === true
				? !equal
				: equal;
	}
	if (opcode === "unary" && fn.instructionAttributes(instruction).operator === "!") {
		const input = operand(0);
		if (input === undefined) return undefined;
		const mask = kindMask(input);
		return compilerValueKindMaskIsSubset(mask, COMPILER_VALUE_KIND_NULLISH)
			? true
			: compilerValueKindMaskIsSubset(
						mask,
						COMPILER_VALUE_KIND_OBJECT | COMPILER_VALUE_KIND_SYMBOL,
				  )
				? false
				: undefined;
	}
	if (opcode === "callKnown") {
		const attributes = fn.instructionAttributes(instruction);
		if (attributes.construct || attributes.argumentMode !== undefined) return undefined;
		switch (attributes.operation) {
			case "Number.isNaN":
			case "Number.isFinite":
			case "Number.isInteger":
			case "Number.isSafeInteger": {
				const input = operand(1);
				const mask =
					input === undefined ? COMPILER_VALUE_KIND_UNDEFINED : kindMask(input);
				if (
					compilerValueKindMaskIsSubset(
						mask,
						COMPILER_VALUE_KIND_TOP & ~COMPILER_VALUE_KIND_NUMBER,
					)
				)
					return false;
				return input !== undefined && integerRange?.(input, instruction) !== undefined
					? attributes.operation !== "Number.isNaN"
					: undefined;
			}
		}
		if (
			attributes.operation === "Array.isArray" ||
			attributes.operation === "ArrayBuffer.isView" ||
			attributes.operation === "JSON.isRawJSON"
		) {
			const input = operand(1);
			const mask = input === undefined ? COMPILER_VALUE_KIND_UNDEFINED : kindMask(input);
			return compilerValueKindMaskIsSubset(
				mask,
				COMPILER_VALUE_KIND_TOP & ~COMPILER_VALUE_KIND_OBJECT,
			)
				? false
				: undefined;
		}
		if (attributes.operation !== "Object.is") return undefined;
		const left = operand(1);
		const right = operand(2);
		if (left === right) return true;
		if (
			left !== undefined &&
			right !== undefined &&
			identity !== undefined &&
			identity(left) === identity(right)
		)
			return true;
		const leftMask = left === undefined ? COMPILER_VALUE_KIND_UNDEFINED : kindMask(left);
		const rightMask =
			right === undefined ? COMPILER_VALUE_KIND_UNDEFINED : kindMask(right);
		if (
			((leftMask || COMPILER_VALUE_KIND_TOP) & (rightMask || COMPILER_VALUE_KIND_TOP)) ===
			0
		)
			return false;
		if (
			leftMask === rightMask &&
			(leftMask === COMPILER_VALUE_KIND_UNDEFINED ||
				leftMask === COMPILER_VALUE_KIND_NULL)
		)
			return true;
		if (
			left !== undefined &&
			right !== undefined &&
			leftMask === COMPILER_VALUE_KIND_NUMBER &&
			rightMask === leftMask
		) {
			const compared = compilerIntegerRangeComparison(
				"===",
				integerRange?.(left, instruction),
				integerRange?.(right, instruction),
			);
			if (compared !== undefined) return compared;
		}
		return left !== undefined &&
			right !== undefined &&
			distinctFreshAllocations(fn, identity?.(left) ?? left, identity?.(right) ?? right)
			? false
			: undefined;
	}
	if (opcode !== "binary" || operandCount !== 2) return undefined;
	const operator = fn.instructionAttributes(instruction).operator;
	const left = operand(0)!;
	const right = operand(1)!;
	if (
		operator === "==" ||
		operator === "!=" ||
		operator === "===" ||
		operator === "!=="
	) {
		if (
			(left === right ||
				(identity !== undefined && identity(left) === identity(right))) &&
			(compilerValueKindMaskIsSubset(
				kindMask(left) & kindMask(right),
				COMPILER_VALUE_KIND_TOP & ~COMPILER_VALUE_KIND_NUMBER,
			) ||
				integerRange?.(left, instruction) !== undefined ||
				integerRange?.(right, instruction) !== undefined)
		)
			return operator === "==" || operator === "===";
		if (
			distinctFreshAllocations(fn, identity?.(left) ?? left, identity?.(right) ?? right)
		)
			return operator === "!=" || operator === "!==";
	}
	if (operator === "==" || operator === "!=") {
		const left = kindMask(operand(0)!);
		const right = kindMask(operand(1)!);
		const nullish = (mask: number) =>
			mask !== 0 && compilerValueKindMaskIsSubset(mask, COMPILER_VALUE_KIND_NULLISH);
		// No object emulates undefined here, so only undefined and null loosely equal them.
		const equal =
			nullish(left) && nullish(right)
				? true
				: (nullish(left) && (right & COMPILER_VALUE_KIND_NULLISH) === 0) ||
					  (nullish(right) && (left & COMPILER_VALUE_KIND_NULLISH) === 0)
					? false
					: undefined;
		return equal === undefined ? undefined : operator === "==" ? equal : !equal;
	}
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
		return coreTypeofComparison(kindMask(input), expected);
	};
	const leftKind = kindMask(left);
	const singleton = (mask: number) =>
		mask === COMPILER_VALUE_KIND_UNDEFINED || mask === COMPILER_VALUE_KIND_NULL;
	const equal =
		typeofResult(left, right) ??
		typeofResult(right, left) ??
		((leftKind & kindMask(right)) === 0
			? false
			: singleton(leftKind) && leftKind === kindMask(right)
				? true
				: undefined);
	return equal === undefined ? undefined : operator === "===" ? equal : !equal;
}

function distinctFreshAllocations(
	fn: CoreFunctionStore,
	left: CoreValueId,
	right: CoreValueId,
): boolean {
	if (left === right) return false;
	return valueIsFreshAllocation(fn, left) && valueIsFreshAllocation(fn, right);
}

function valueIsFreshAllocation(fn: CoreFunctionStore, value: CoreValueId): boolean {
	if (fn.kernel.valueDefinitionKind(value) !== 1) return false;
	const instruction = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
	return fn.registry.byId(fn.instructionOpcode(instruction)).allocation !== undefined;
}

export function coreOperatorInputKindMasks(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	kinds: CoreValueKindAnalysis,
): CompilerOperatorInputKindMasks | undefined {
	const opcode = fn.instructionOpcodeName(instruction);
	const start = fn.kernel.instructionOperandStart(instruction);
	const left = kinds.kindMask(fn.kernel.operandAt(start));
	if (left === 0) return undefined;
	if (opcode === "unary") return left === COMPILER_VALUE_KIND_TOP ? undefined : [left];
	if (opcode !== "binary") return undefined;
	const right = kinds.kindMask(fn.kernel.operandAt(start + 1));
	if (right === 0) return undefined;
	return left === COMPILER_VALUE_KIND_TOP && right === COMPILER_VALUE_KIND_TOP
		? undefined
		: [left, right];
}

export function coreExactOperatorInputKindMasks(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): CompilerOperatorInputKindMasks | undefined {
	const refinement = fn.instructionEffectRefinement(instruction);
	if (refinement === undefined) return undefined;
	const fact = fn.fact(refinement.proof);
	const masks = fact.value;
	return fact.kind === CORE_PRIMITIVE_EFFECT_FACT &&
		Array.isArray(masks) &&
		masks.every((mask) => compilerValueKindMaskIsValid(mask, { allowTop: true })) &&
		compilerOperatorInputKindsHaveExactNativeSemantics(
			fn.instructionOpcodeName(instruction),
			fn.instructionAttributes(instruction).operator,
			masks,
		)
		? masks
		: undefined;
}

export function corePrimitiveEffectRefinement(
	program: CoreProgram,
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	masks: ReadonlyArray<CompilerValueKindMask>,
): CoreInstructionEffects | undefined {
	const opcode = fn.instructionOpcodeName(instruction);
	if (
		opcode === "queryStaticData" &&
		fn.instructionAttributes(instruction).queryKind === "has-own" &&
		masks.length === 2 &&
		compilerValueKindMaskIsSubset(
			masks[0]!,
			COMPILER_VALUE_KIND_STRING | COMPILER_VALUE_KIND_SYMBOL,
		)
	) {
		const offset = fn.instructionAttributes(instruction).templateOffset;
		if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0)
			return undefined;
		const count = program.literalTemplateData[offset + 1];
		if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
			return undefined;
		if (count >= STATIC_DATA_QUERY_POLL_INTERVAL) return STATIC_OWN_KEY_EFFECTS;
		const template = validateStaticQueryTemplate(
			program.literalTemplateData,
			offset,
			"has-own",
		);
		if (
			template.stringReferences.some(
				({ index }) => index >= program.stringConstants.length,
			)
		)
			return undefined;
		return NO_EFFECT_SUMMARY;
	}
	if (
		opcode === "deleteProperty" &&
		masks.length === 2 &&
		compilerValueKindsHaveEmptyPrimitiveWrappers(masks[0]!) &&
		compilerValueKindMaskIsSubset(
			masks[1]!,
			COMPILER_VALUE_KIND_TOP & ~COMPILER_VALUE_KIND_OBJECT,
		)
	)
		return NO_EFFECT_SUMMARY;
	const operator = fn.instructionAttributes(instruction).operator;
	let primitive = false;
	let gcFree = false;
	let mayThrow = false;
	if (opcode === "unary" && masks.length === 1 && typeof operator === "string") {
		const numericPrimitive = compilerValueKindMaskIsSubset(
			masks[0]!,
			COMPILER_VALUE_KIND_TO_NUMBER_PRIMITIVE,
		);
		const stringPrimitive =
			operator === "tostring" &&
			compilerValueKindMaskIsSubset(masks[0]!, COMPILER_VALUE_KIND_TO_STRING_PRIMITIVE);
		const coercion =
			(NUMERIC_UNARY_OPERATORS.has(operator) || operator === "tostring") &&
			compilerValueKindMaskIsSubset(
				masks[0]!,
				COMPILER_VALUE_KIND_TOP & ~COMPILER_VALUE_KIND_OBJECT,
			);
		primitive = NON_COERCING_UNARY_OPERATORS.has(operator) || coercion;
		gcFree =
			NON_COERCING_UNARY_OPERATORS.has(operator) ||
			(NUMERIC_UNARY_OPERATORS.has(operator) && numericPrimitive) ||
			(stringPrimitive && masks[0] === COMPILER_VALUE_KIND_STRING);
		mayThrow =
			coercion && !(operator === "tostring" ? stringPrimitive : numericPrimitive);
	} else if (opcode === "binary" && masks.length === 2 && typeof operator === "string") {
		const left = masks[0]!,
			right = masks[1]!;
		const strict = operator === "===" || operator === "!==";
		const equality = strict || operator === "==" || operator === "!=";
		const nonReentrantComparison = compilerComparisonInputKindsAvoidObjectCoercion(
			operator,
			masks,
		);
		const comparisonThrows =
			nonReentrantComparison &&
			!equality &&
			((left | right) & COMPILER_VALUE_KIND_SYMBOL) !== 0;
		// BigInt comparison with String may materialize UTF-16 parsing storage.
		const comparisonMaterializes =
			((left & COMPILER_VALUE_KIND_STRING) !== 0 &&
				(right & COMPILER_VALUE_KIND_BIGINT) !== 0) ||
			((right & COMPILER_VALUE_KIND_STRING) !== 0 &&
				(left & COMPILER_VALUE_KIND_BIGINT) !== 0);
		const numericPrimitives = masks.every((mask) =>
			compilerValueKindMaskIsSubset(mask, COMPILER_VALUE_KIND_NUMERIC_PRIMITIVE),
		);
		const stringConcatenation =
			(operator === "+" &&
				masks.every((mask) =>
					compilerValueKindMaskIsSubset(mask, COMPILER_VALUE_KIND_STRING),
				)) ||
			compilerOperatorIsPrimitiveStringConcatenation(opcode, operator, masks);
		primitive =
			nonReentrantComparison ||
			(NUMERIC_BINARY_OPERATORS.has(operator) && numericPrimitives) ||
			stringConcatenation ||
			compilerOperatorInputKindsHaveExactNativeSemantics(opcode, operator, masks);
		gcFree =
			strict ||
			(nonReentrantComparison && !comparisonThrows && !comparisonMaterializes) ||
			compilerOperatorIsNullishEquality(opcode, operator, masks) ||
			(numericPrimitives &&
				(NUMERIC_BINARY_OPERATORS.has(operator) ||
					compilerOperatorFixedResultKind(opcode, operator) ===
						COMPILER_VALUE_KIND_BOOLEAN));
		mayThrow = stringConcatenation || comparisonThrows;
	}
	if (!primitive) return undefined;
	const baseline = fn.registry.byId(fn.instructionOpcode(instruction)).effects;
	return {
		reads: baseline.reads.filter((domain) => domain !== "host"),
		writes: baseline.writes.filter((domain) => domain !== "host"),
		mayThrow: mayThrow && baseline.mayThrow,
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
