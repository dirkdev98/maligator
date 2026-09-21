import type { CorePropertyPlacement } from "../core/core-ir-regions.ts";
import {
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_NULL,
	COMPILER_VALUE_KIND_STRING,
	COMPILER_VALUE_KIND_BOOLEAN,
	COMPILER_VALUE_KIND_NUMERIC_PRIMITIVE,
	compilerValueKindMaskIsSubset,
	COMPILER_VALUE_KIND_NUMBER_OR_UNDEFINED,
	COMPILER_VALUE_KIND_UNDEFINED,
} from "../shared/compiler-value-kinds.ts";
import type { CompilerValueKindMask } from "../shared/compiler-value-kinds.ts";
import {
	knownBuiltinErrors,
	knownBuiltinErrorPrototype,
} from "../shared/known-builtin-errors.ts";
import { knownNativeEntries } from "../shared/known-native-entries.ts";
import { knownOperationFlags, knownOperations } from "../shared/known-operations.ts";
import { knownOperationIndex } from "../shared/known-operations.ts";
import {
	NATIVE_STRING_SWITCH_CODE_UNIT_LIMIT,
	nativeStringSwitchHash,
} from "../shared/native-string-switch.ts";
import { staticDataQueryTag } from "../shared/static-data-query.ts";
import { stringCaseLocale } from "../shared/string-case-locale.ts";
import {
	emitBinaryOperator,
	emitIntrinsic,
	emitTypeofResult,
	emitUnaryOperator,
} from "./emit-program-image.ts";
import { lowerNativeFastPaths } from "./lower-native-fast-paths.ts";
import type {
	NativeConstructorInitializationAction,
	NativePairedArrayLoopAction,
	NativePairedArrayLoopPlan,
	NativePropertyProjectionAction,
	NativePropertyProjectionOperand,
} from "./lower-native-fast-paths.ts";
import { profileOperationForInstruction } from "./profile-metadata.ts";
import {
	nativeFrameRootRegisters,
	vmCallProvesBuiltin,
	validateNativeDirectEntry,
	validateNativeLiteralSwitches,
	vmRegionActionsAreCurrent,
	vmNativeInstructionMayCaptureStack as nativeInstructionMayCaptureStack,
	vmSemanticProtectorGuard,
} from "./program-image.ts";
import type {
	NativeFunctionPlan,
	NativeDirectEntryPlan,
	NativeInstructionPlan,
	VmGuardPlan,
	VmRegion,
	VmRegionAction,
	VmRegionLicense,
	VmRegisterRepresentation,
	VmSemanticDependency,
	VmSemanticProtectorFact,
	VmStackObjectPlanRegion,
} from "./program-image.ts";
import {
	computeArgumentRetentionLimit,
	decodeVmValueOperand,
	vmExceptionHandlerTargets as exceptionHandlerTargets,
} from "./runtime-image.ts";
import type { BytecodeFunction, BytecodeInstruction } from "./runtime-image.ts";

/**
 * The native-C backend: lower an eligible function straight to a C function
 * (no VM dispatch loop), installed as MalFunction.compiled. Only a subset of
 * opcodes is lowered; anything else makes a function ineligible (it falls back
 * to the interpreter).
 *
 * VALUE REPRESENTATION & UNBOXING: each register has a `RegisterRep`. A register
 * that Core target lowering marks as always holding a JS number —
 * literals and the results of +,-,*,/ and unary -,+ over other proven-number
 * registers — gets the `number` rep and is emitted as a C `double`, with native
 * arithmetic and no per-op type checks or boxing. Such a value is boxed (via
 * mal_ops_number_value, which canonicalizes int32/-0/NaN exactly as the
 * interpreter does) only at boundaries: when it flows into a boxed op, a global
 * store, a condition, or the return. This is guard-free: the proof is static, so
 * no runtime type checks are needed.
 *
 * MIXED-REP GUARDS: a binary op with one proven-number operand and one boxed
 * operand (typically a still-boxed parameter, e.g. the `i < n` of a counted
 * loop) emits a speculative fast path — `mal_ops_is_number(boxed) ? <native
 * double op> : <fully-general op>`. The guard is a few inline bit tests
 * (mal_ops_is_number / mal_ops_number_as_f64 are static inline in value_ops.h),
 * cheap and perfectly predicted in a hot loop, so the boxed operand never forces
 * a non-inlined value_ops call when it is in fact a number. The fast path is
 * observably identical to the fallback by construction.
 *
 * BOOLEANS: a register that always holds a JS boolean — the result of a
 * comparison, a logical `!`, or a boolean literal — gets the `boolean` rep and
 * is emitted as a C `bool`. A comparison then writes a raw bool (no
 * mal_value_new_boolean), a JUMP_IF on it branches directly (no
 * mal_value_is_truthy), and it is boxed (mal_value_new_boolean) only at a
 * boundary. A counted loop's `i < n` condition becomes a native compare feeding
 * a native branch with no boxing round-trip at all.
 *
 * The int32-overflow fix in mal_ops (add/sub/mul now promote to f64) is what
 * makes the unboxed double arithmetic behavior-identical to the interpreter.
 */

/**
 * How a register's value is held in the emitted C: a raw C `double`, a raw C
 * `bool`, or a boxed `MalValue`. A register reused across its lifetime for
 * values of different reps joins to `boxed` in the target-lowering plan.
 */
type RegisterRep = VmRegisterRepresentation;

function isNumericRep(rep: RegisterRep): boolean {
	return rep === "number" || rep === "int32";
}

export interface BackendProfileDecision {
	instructionIndex: number;
	operation: string;
	code: string;
	outcome: "applied" | "elided" | "guarded" | "retained" | "fallback";
	reasonCode?: string;
	details?: Record<string, string | number | boolean>;
}

const MATH_UNARY_NATIVE_CALL: ReadonlyMap<string, string | null> = new Map([
	["Math.abs", "fabs"],
	["Math.floor", "floor"],
	["Math.ceil", "ceil"],
	["Math.round", null],
	["Math.trunc", "trunc"],
	["Math.sqrt", "sqrt"],
	["Math.cbrt", "cbrt"],
	["Math.sign", null],
	["Math.log", "log"],
	["Math.log2", "log2"],
	["Math.log10", "log10"],
	["Math.exp", "exp"],
	["Math.sin", "sin"],
	["Math.cos", "cos"],
	["Math.tan", "tan"],
	["Math.asin", "asin"],
	["Math.acos", "acos"],
	["Math.atan", "atan"],
	["Math.sinh", "sinh"],
	["Math.cosh", "cosh"],
	["Math.tanh", "tanh"],
	["Math.asinh", "asinh"],
	["Math.acosh", "acosh"],
	["Math.atanh", "atanh"],
	["Math.log1p", "log1p"],
	["Math.expm1", "expm1"],
	["Math.fround", null],
] as const);

function nativeMathUnaryExpr(operation: string, argument: string): string | null {
	const nativeCall = MATH_UNARY_NATIVE_CALL.get(operation);
	if (nativeCall === undefined) return null;
	if (nativeCall !== null) return `${nativeCall}(${argument})`;
	switch (operation) {
		case "Math.sign":
			return `(${argument} > 0.0 ? 1.0 : (${argument} < 0.0 ? -1.0 : ${argument}))`;
		case "Math.fround":
			return `(f64) (f32) ${argument}`;
		case "Math.round":
			// Adding 0.5 first can round twice; preserve signed zero and already-integral large values.
			return `(${argument} == 0.0 || !(fabs(${argument}) < 0x1p52) ? ${argument} : (${argument} >= -0.5 && ${argument} < 0.0 ? -0.0 : (${argument} - floor(${argument}) < 0.5 ? floor(${argument}) : floor(${argument}) + 1.0)))`;
		default:
			return null;
	}
}

const NUMBER_FORMAT_KERNELS: Readonly<
	Record<string, readonly [string, number, number, number]>
> = {
	"Number.prototype.toString": ["string", 2, 36, 10],
	"Number.prototype.toFixed": ["fixed", 0, 100, 0],
	"Number.prototype.toExponential": ["exponential", 0, 100, -1],
	"Number.prototype.toPrecision": ["precision", 1, 100, -1],
};

const NUMBER_PREDICATES = new Map([
	["Number.isNaN", "MAL_NUMBER_PREDICATE_IS_NAN"],
	["Number.isFinite", "MAL_NUMBER_PREDICATE_IS_FINITE"],
	["Number.isInteger", "MAL_NUMBER_PREDICATE_IS_INTEGER"],
	["Number.isSafeInteger", "MAL_NUMBER_PREDICATE_IS_SAFE_INTEGER"],
]);

const STRING_SEARCH_KERNELS: Readonly<Record<string, readonly [string, string]>> = {
	"String.prototype.indexOf": ["INDEX_OF", "0.0"],
	"String.prototype.lastIndexOf": ["LAST_INDEX_OF", "NAN"],
	"String.prototype.includes": ["INCLUDES", "0.0"],
	"String.prototype.startsWith": ["STARTS_WITH", "0.0"],
	"String.prototype.endsWith": ["ENDS_WITH", "INFINITY"],
};

const STRING_HTML_KERNELS: Readonly<Record<string, readonly [string, string?]>> = {
	anchor: ["a", "name"],
	big: ["big"],
	blink: ["blink"],
	bold: ["b"],
	fixed: ["tt"],
	fontcolor: ["font", "color"],
	fontsize: ["font", "size"],
	italics: ["i"],
	link: ["a", "href"],
	small: ["small"],
	strike: ["strike"],
	sub: ["sub"],
	sup: ["sup"],
};

const URI_KERNELS: Readonly<Record<string, readonly [string, boolean?]>> = {
	encodeURI: ["encode", false],
	encodeURIComponent: ["encode", true],
	decodeURI: ["decode", true],
	decodeURIComponent: ["decode", false],
	"globalThis.escape": ["escape"],
	"globalThis.unescape": ["unescape"],
};

const STRING_RANGE_KERNELS: Readonly<Record<string, string>> = {
	"String.prototype.slice": "SLICE",
	"String.prototype.substring": "SUBSTRING",
	"String.prototype.substr": "SUBSTR",
};

const STRING_CHARACTER_KERNELS: Readonly<Record<string, string>> = {
	"String.prototype.at": "AT",
	"String.prototype.charAt": "CHAR_AT",
	"String.prototype.codePointAt": "CODE_POINT_AT",
};

const MATH_NUMBER_KERNELS: Readonly<Record<string, readonly [string, number]>> = {
	"Math.clz32": ["mal_builtin_math_clz32_number", 1],
	"Math.f16round": ["mal_builtin_math_f16round_number", 1],
	"Math.imul": ["mal_builtin_math_imul_number", 2],
	"Math.pow": ["mal_builtin_math_pow_number", 2],
	"Math.atan2": ["atan2", 2],
};

const MATH_BINARY_OPERATIONS = new Set(["Math.min", "Math.max"]);

function nativeMathBinaryExpr(
	operation: string,
	left: string,
	right: string,
): string | null {
	if (!MATH_BINARY_OPERATIONS.has(operation)) return null;
	const maximum = operation === "Math.max";
	const compare = maximum ? ">" : "<";
	const negativeZero = `signbit(${left}) ${maximum ? "&&" : "||"} signbit(${right})`;
	// C fmin/fmax can discard a NaN operand and do not establish this signed-zero contract.
	return `(isnan(${left}) || isnan(${right}) ? NAN : (${left} == 0.0 && ${right} == 0.0 ? (${negativeZero} ? -0.0 : 0.0) : (${left} ${compare} ${right} ? ${left} : ${right})))`;
}

interface NativeCallCoverage {
	readonly emittedInstructions: ReadonlySet<number>;
	readonly directEntryCalls: ReadonlyMap<number, ReadonlySet<number>>;
}

export interface CompiledFunction extends NativeCallCoverage {
	/** The C symbol to install as MalFunction.compiled. */
	symbol: string;
	/** Final decisions from the exact emitted variant, never an exploratory pass. */
	profileDecisions: Array<BackendProfileDecision>;
	/** The full `static MalValue ...(...) { ... }` definition. */
	source: string;
	/** Additional native-only ordinary-call symbols emitted beside the canonical body. */
	directEntries: Array<{
		emittedInstructions: ReadonlySet<number>;
		directEntryCalls: ReadonlyMap<number, ReadonlySet<number>>;
		id: number;
		symbol: string;
		/**
		 * Independently emitted definition so an optional ABI sibling cannot evict the canonical body.
		 */
		source: string;
		parameterRepresentations: ReadonlyArray<VmRegisterRepresentation>;
		resultRepresentation: VmRegisterRepresentation;
		leaf?: true;
	}>;
}

export type DirectCompiledEntries = ReadonlyMap<
	string,
	NativeDirectEntryPlan & { readonly leaf?: true }
>;

interface NativeRelocationExpressions {
	readonly enabled: boolean;
	functionIndex(index: number): string;
	ownerFunctionIndex(index: number): string;
	globalIndex(index: number): string;
	stringIndex(index: number): string;
	bigintIndex(index: number): string;
	templateOffset(index: number): string;
	sourcePosition(index: number): string;
	stringValue(index: number, suffix: string): string;
	bigintValue(index: number, suffix: string): string;
}

function nativeRelocationExpressions(enabled: boolean): NativeRelocationExpressions {
	const indexed = (base: string, index: number): string =>
		enabled ? `(__mal_relocation->${base} + ${index})` : String(index);
	return {
		enabled,
		functionIndex: (index) => indexed("function_base", index),
		ownerFunctionIndex: (index) =>
			index < 0 ? String(index) : indexed("function_base", index),
		globalIndex: (index) => indexed("global_base", index),
		stringIndex: (index) => indexed("string_base", index),
		bigintIndex: (index) => indexed("bigint_base", index),
		templateOffset: (index) => indexed("literal_template_base", index),
		sourcePosition: (index) => indexed("source_position_base", index),
		stringValue: (index, suffix) =>
			enabled
				? `mal_value_from_string(&vm->runtime_image->string_constants[${indexed("string_base", index)}])`
				: `mal_value_from_string(&mal_strings${suffix}[${index}])`,
		bigintValue: (index, suffix) =>
			enabled
				? `mal_value_from_bigint(&vm->runtime_image->bigint_constants[${indexed("bigint_base", index)}])`
				: `mal_value_from_bigint(&mal_bigints${suffix}[${index}])`,
	};
}

export function directCompiledEntryKey(functionIndex: number, entryId: number): string {
	return `${functionIndex}:${entryId}`;
}

/**
 * Threaded through the body emission for a resumable (generator/async) function.
 * A coroutine holds every register boxed in a heap buffer named `__gc_slots` (so
 * the existing register/with-object references work unchanged), indexed directly
 * by register number; `selfSlot` is the trailing buffer slot holding the
 * coroutine object (rooting its yielded value / async fields). GENERATOR_START,
 * YIELD, AWAIT and the coroutine RETURN forms consult this. Null for ordinary
 * straight-line functions.
 */
interface CoroutineContext {
	functionIndex: number;
	selfSlot: number;
	/** Runtime condition for copying call arguments into the suspended frame. */
	retainArguments: string;
	/** Async function (not a generator): returns its result promise, uses ASYNC_START/AWAIT. */
	isAsyncFunction: boolean;
	/** `async function*`: GENERATOR_START-based, but its yields await + settle requests. */
	isAsyncGenerator: boolean;
}

/**
 * The property producer a region's declining fast path must run for itself, or
 * undefined when Core kept the load in place. The choice is Core's — the emitter
 * reads `propertyPlacement` and never rediscovers it from the distance between
 * the load and its call, which would make an optimization depend on layout.
 *
 * A deferred load leaves its callee register unwritten on the fast path, so the
 * region must also hold a locked identity whose fast form never reads that
 * register. Core proves this and the target boundary re-checks it; a mismatch here
 * is a broken certificate rather than a reason to emit the load anyway.
 */
function regionFallbackPropertyLoad(
	fn: BytecodeFunction,
	placement: CorePropertyPlacement,
	propertyIp: number,
	lockedIdentity: boolean,
): Extract<BytecodeInstruction, { opcode: "LOAD_PROPERTY_STATIC" }> | undefined {
	if (placement !== "call-fallback") return undefined;
	const instruction = fn.instructions[propertyIp];
	if (instruction?.opcode !== "LOAD_PROPERTY_STATIC") {
		throw new Error(
			`Deferred region property at instruction ${propertyIp} is not a load`,
		);
	}
	if (!lockedIdentity) {
		throw new Error(
			`Deferred region property at instruction ${propertyIp} has no locked identity`,
		);
	}
	return instruction;
}

/**
 * The resume points of a coroutine — the instruction after each suspend
 * (GENERATOR_START/YIELD/AWAIT), where a resume re-enters. The instruction pointer
 * is advanced past the suspend before the frame is saved, so the resume IP is the
 * following instruction.
 */
function resumePointsOf(fn: BytecodeFunction): Array<number> {
	const points: Array<number> = [];
	for (let ip = 0; ip < fn.instructions.length; ip++) {
		const opcode = fn.instructions[ip]!.opcode;
		if (opcode === "GENERATOR_START" || opcode === "YIELD" || opcode === "AWAIT") {
			points.push(ip + 1);
		}
	}
	return points;
}

/**
 * Render an f64 value as a valid C double expression. `toExponential()` is fine
 * for finite values but yields the bare words `Infinity`/`NaN` for non-finite
 * ones, which are not C constants — emit compiler builtins instead (no <math.h>
 * dependency). NaN cannot appear in a source literal, but a folded computation
 * could, so it is handled defensively.
 */
export function cF64Literal(value: number): string {
	if (Object.is(value, -0)) {
		return "-0.0";
	}
	if (Number.isNaN(value)) {
		return '__builtin_nan("")';
	}
	if (value === Infinity) {
		return "__builtin_inf()";
	}
	if (value === -Infinity) {
		return "-__builtin_inf()";
	}
	return value.toExponential();
}

const THROWING_UNARY_OPERATORS = new Set(["+", "tonumeric", "tostring"]);

/**
 * Binary operators emitted as native C on two `number`-rep operands. Arithmetic
 * produces a `number`; comparison produces a boxed boolean.
 */
const NATIVE_ARITH: Record<string, string> = {
	"+": "+",
	"-": "-",
	"*": "*",
	"/": "/",
};
const NATIVE_COMPARE: Record<string, string> = {
	"<": "<",
	"<=": "<=",
	">": ">",
	">=": ">=",
	"===": "==",
	"==": "==",
	"!==": "!=",
	"!=": "!=",
};

/**
 * The relational comparisons. When BOTH operands are boxed (no static proof
 * either is a number) the backend still speculates a numeric compare for these —
 * `a < b` is overwhelmingly numeric in hot code and relational comparison coerces
 * to a number anyway — but NOT for equality (both-boxed `==`/`===` is typically
 * object/string identity, where the numeric bet loses and the strict slow path is
 * already coercion-free). The mixed case (one operand proven number) still
 * speculates every comparison, equality included: there the numeric prior is real.
 */
const RELATIONAL_COMPARE = new Set<string>(["<", "<=", ">", ">="]);

/**
 * Bitwise/shift operators emitted as native C on two `number`-rep operands.
 * JS defines these over ToInt32 (mal_ops_number_to_i32), with the shift count
 * masked to 5 bits. The signed-32-bit result is held as a `number`-rep double
 * and boxed back to an int32 by mal_ops_number_value, behavior-identical to the
 * interpreter's mal_ops_bit_and / shift_left and friends. (`>>>` yields a uint32
 * and `%` a float remainder; both also produce `number`-rep, emitted bespoke.)
 */
const NATIVE_BITWISE: Record<string, string> = {
	"&": "&",
	"|": "|",
	"^": "^",
	"<<": "<<",
	">>": ">>",
};

// Exponentiation has a separate proven-input path because its target representation stays boxed.
function producesNumberFromNumbers(operator: string): boolean {
	return (
		operator in NATIVE_ARITH ||
		operator in NATIVE_BITWISE ||
		operator === ">>>" ||
		operator === "%"
	);
}

function nativeInt32Expr(operator: string, left: string, right: string): string | null {
	const bitwise = NATIVE_BITWISE[operator];
	if (bitwise === undefined) return null;
	if (operator === "<<") {
		// Unsigned shifting preserves the low 32 bits without signed-overflow UB.
		return `mal_ops_u32_to_i32((u32) ${left} << (${right} & 0x1F))`;
	}
	const right32 = operator === ">>" ? `(${right} & 0x1F)` : right;
	return `${left} ${bitwise} ${right32}`;
}

function nativeNumberExpr(operator: string, left: string, right: string): string | null {
	const arith = NATIVE_ARITH[operator];
	if (arith !== undefined) {
		return `${left} ${arith} ${right}`;
	}
	const bitwise = nativeInt32Expr(
		operator,
		`mal_ops_number_to_i32(${left})`,
		`mal_ops_number_to_i32(${right})`,
	);
	if (bitwise !== null) return `(f64) (${bitwise})`;
	if (operator === ">>>") {
		return `(f64) ((u32) mal_ops_number_to_i32(${left}) >> (mal_ops_number_to_i32(${right}) & 0x1F))`;
	}
	if (operator === "%") {
		return `mal_number_remainder(${left}, ${right})`;
	}
	return null;
}

/**
 * Operators whose fully-general op never sets a THROW completion, so a boxed
 * fallback can skip the check. Only the strict-equality operators qualify:
 * they compare without any coercion. Every other operator can throw — `in`/
 * `instanceof` directly, arithmetic/bitwise/shift on a BigInt domain error, and
 * the relational/loose-equality comparisons whenever an object operand runs a
 * throwing valueOf/toString (ToPrimitive) or a Symbol forces a TypeError.
 */
const NON_THROWING_BINARY = new Set<string>(["===", "!=="]);

/**
 * Whether a binary operator can leave a THROW completion that a boxed fallback
 * must propagate. The boxed (and mixed-rep fallback) paths reach the general op,
 * so they need the completion check unless the operator can never throw.
 */
function binaryOpCanThrow(operator: string): boolean {
	return !NON_THROWING_BINARY.has(operator);
}

export function nativeInactiveRootMasks(
	safepoints: NativeFunctionPlan["gc"]["safepoints"],
	slotOfRegister: ReadonlyMap<number, number>,
): ReadonlyMap<number, bigint> {
	if (safepoints.length === 0) return new Map();
	const slotBits = new Map<number, bigint>();
	let allSlots = 0n;
	for (const [register, slot] of slotOfRegister) {
		if (slot >= 64) continue;
		const bit = 1n << BigInt(slot);
		slotBits.set(register, bit);
		allSlots |= bit;
	}
	if (allSlots === 0n) return new Map();
	const masks = new Map<number, bigint>();
	let removesAnyRoot = false;
	for (const safepoint of safepoints) {
		let liveSlots = 0n;
		for (const register of safepoint.rootRegisters) {
			liveSlots |= slotBits.get(register) ?? 0n;
		}
		const mask = allSlots & ~liveSlots;
		masks.set(safepoint.instructionIp, mask);
		removesAnyRoot ||= mask !== 0n;
	}
	return removesAnyRoot ? masks : new Map();
}

function cInactiveRootMaskPublication(mask: bigint): string {
	return `MAL_ROOT_MASK(0x${mask.toString(16)})`;
}

/**
 * Emit a compiled C function for `fn`, or null when it uses a construct the
 * backend doesn't lower yet (the caller then leaves it to the interpreter).
 */
function emitCompiledVariant(
	fn: BytecodeFunction,
	native: NativeFunctionPlan,
	index: number,
	suffix: string,
	debug: boolean,
	linkage: "static" | "external" = "static",
	directCompiledTargets: ReadonlySet<number> = new Set(),
	semanticProtectors: ReadonlyArray<VmSemanticProtectorFact> = [],
	directCompiledEntries: DirectCompiledEntries = new Map(),
	relocatable = false,
	directEntry?: NativeDirectEntryPlan,
	strictCompiledTargets: ReadonlySet<number> = new Set(),
	stringConstants: ReadonlyArray<ReadonlyArray<number>> = [],
): CompiledFunction | null {
	// Generators and async functions suspend mid-body: they lower to a resumable C
	// function (a heap register frame + entry dispatch to the saved resume point)
	// rather than the straight-line shape below (see emitResumableFunction).
	if (fn.isGenerator || fn.isAsync) {
		if (directEntry !== undefined || relocatable) return null;
		return emitResumableFunction(
			fn,
			native,
			index,
			suffix,
			debug,
			linkage,
			semanticProtectors,
			stringConstants,
		);
	}
	if (directEntry !== undefined) validateNativeDirectEntry(fn, directEntry);
	validateNativeLiteralSwitches(fn, native);
	const nativeContract: NativeFunctionPlan =
		directEntry === undefined
			? native
			: {
					...native,
					registerRepresentations: directEntry.registerRepresentations,
					gc: directEntry.gc,
					instructions: (() => {
						const instructions = [...native.instructions];
						for (const { instructionIp, masks } of directEntry.operatorInputs ?? []) {
							if (instructions[instructionIp]?.kind !== "unsigned-arithmetic")
								instructions[instructionIp] = {
									kind: "exact-operator-input-kinds",
									inputKindMasks: masks,
								};
						}
						return instructions;
					})(),
				};

	// A function with its own captured slots needs a per-activation MalEnv node
	// (function_index == this function) for LOAD/STORE_CAPTURED(owner == self) and
	// for the closures it creates to capture. The interpreter's
	// push_function_frame allocates it; the compiled function allocates the same
	// node at entry (below) and reassigns `env` to it, so the body's captured
	// access and CREATE_FUNCTION see this activation's slots.
	const capturesEnv = fn.capturedCount > 0;

	if (
		nativeContract.registerRepresentations.length !== fn.registerCount ||
		nativeContract.registerRepresentations.some(
			(representation, register) =>
				(representation !== "boxed" &&
					representation !== "int32" &&
					representation !== "number" &&
					representation !== "boolean" &&
					representation !== "string") ||
				(register < fn.parameterCount &&
					representation !==
						(directEntry?.parameterRepresentations[register] ?? "boxed")),
		)
	) {
		throw new Error(`Invalid register representations for function ${index}`);
	}
	const reps = [...nativeContract.registerRepresentations];
	const relocation = nativeRelocationExpressions(relocatable);

	// MalValue-typed registers can hold heap pointers, so they are GC roots: back
	// them with a contiguous `__gc_slots` array published as a MalRootFrame, so a
	// collection at a call/back-edge safepoint inside this function can mark them.
	// (number/boolean-rep registers hold unboxed scalars — never heap pointers.)
	// The registers ARE the slots (via `#define r<i> (__gc_slots[<slot>])`), so no
	// spilling is needed; every exit must unlink the frame (gcUnlink).
	//
	// Execution lowering owns precise per-safepoint physical-register liveness,
	// including operation operands/results, exceptional exits, target temporaries,
	// and native loop-backedge polls. This static-shadow-frame backend consumes that
	// contract by allocating the union of its exact maps and publishing dead-slot
	// masks at each individual site. It never re-runs liveness or infers GC policy
	// from bytecode; slots beyond the fixed-width mask remain conservatively rooted.
	const rootRegisters = new Set(nativeFrameRootRegisters(fn, nativeContract));
	const valueRegs: Array<number> = [];
	for (let i = 0; i < fn.registerCount; i++) {
		const isBoxed = !isNumericRep(reps[i]!) && reps[i] !== "boolean";
		if (isBoxed && rootRegisters.has(i)) {
			valueRegs.push(i);
		}
	}
	const slotOf = new Map<number, number>();
	valueRegs.forEach((reg, slot) => slotOf.set(reg, slot));
	const slotCount = valueRegs.length;
	const inactiveRootMasks = nativeInactiveRootMasks(nativeContract.gc.safepoints, slotOf);
	const gcSafepointKinds = new Map(
		nativeContract.gc.safepoints.map((safepoint) => [
			safepoint.instructionIp,
			safepoint.kind,
		]),
	);

	// A derived constructor's `this` is uninitialized (the EMPTY sentinel) until
	// super() binds it, and CONSTRUCT_SUPER reassigns it mid-body — so it can't be
	// the immutable `this_value` parameter. It lives in its own rooted slot (the
	// bound instance is live across the rest of the body), initialized from the
	// EMPTY parameter and read through the TDZ-checked LOAD_THIS / RETURN forms.
	const thisSlot = fn.isDerivedConstructor ? slotCount : -1;
	const stackSlotsBase = slotCount + (fn.isDerivedConstructor ? 1 : 0);
	const stackObjectSites = new Map<number, StackObjectSite>();
	let nextStackSlot = stackSlotsBase;
	for (const action of nativeContract.regionActions) {
		const region = nativeContract.specializations[action.regionIndex];
		if (region?.kind !== "stack-object-plan" || action.role !== "allocate") continue;
		const site = region.sites[action.primaryIndex ?? -1];
		if (site === undefined || action.ip !== site.allocationIp) {
			throw new Error("Invalid stack-object allocation action");
		}
		const instruction = fn.instructions[site.allocationIp];
		if (
			(instruction?.opcode !== "CREATE_OBJECT" &&
				instruction?.opcode !== "CREATE_OBJECT_SHAPED") ||
			(instruction.opcode === "CREATE_OBJECT"
				? site.slotCount !== 0
				: instruction.count !== site.slotCount) ||
			stackObjectSites.has(site.allocationIp)
		) {
			throw new Error(
				`Invalid stack-object metadata at instruction ${site.allocationIp}`,
			);
		}
		const scalarSlotRepresentation = stackObjectScalarSlotRepresentation(
			fn,
			nativeContract,
			region,
			site,
		);
		const elided = site.mode === "elided";
		stackObjectSites.set(site.allocationIp, {
			objectName: `__stack_object_${site.allocationIp}`,
			...(elided
				? { elided: true }
				: scalarSlotRepresentation === undefined
					? { slotsOffset: nextStackSlot }
					: {
							scalarSlot: {
								name: `__stack_object_${site.allocationIp}_slot_0`,
								representation: scalarSlotRepresentation,
							},
						}),
			slotCount: site.slotCount,
		});
		if (!elided && scalarSlotRepresentation === undefined)
			nextStackSlot += site.slotCount;
	}
	const stackObjectMaterializations = new Map<number, StackObjectSite>();
	const stackObjectAccesses = new Map<number, { site: StackObjectSite; slot: number }>();
	const stackObjectInheritedAccesses = new Map<number, StackObjectSite>();
	for (const action of nativeContract.regionActions) {
		const region = nativeContract.specializations[action.regionIndex];
		if (region?.kind !== "stack-object-plan" || action.role === "allocate") continue;
		const planSite = region.sites[action.primaryIndex ?? -1];
		const site =
			planSite === undefined ? undefined : stackObjectSites.get(planSite.allocationIp);
		if (planSite === undefined || site === undefined) {
			throw new Error("Stack-object action has no allocation site");
		}
		if (action.role === "materialize") {
			const materialization = planSite.materializations[action.secondaryIndex ?? -1];
			const instruction = fn.instructions[action.ip];
			if (
				materialization?.ip !== action.ip ||
				materialization.kind !== "return" ||
				instruction?.opcode !== "RETURN" ||
				stackObjectMaterializations.has(action.ip)
			) {
				throw new Error(
					`Invalid stack-object materialization metadata at instruction ${action.ip}`,
				);
			}
			stackObjectMaterializations.set(action.ip, site);
		} else if (action.role === "access") {
			const access = planSite.accesses[action.secondaryIndex ?? -1];
			const instruction = fn.instructions[action.ip];
			if (
				access?.ip !== action.ip ||
				(instruction?.opcode !== "LOAD_PROPERTY_STATIC" &&
					instruction?.opcode !== "STORE_PROPERTY_STATIC" &&
					instruction?.opcode !== "LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT" &&
					instruction?.opcode !== "STORE_PROPERTY_STATIC_KNOWN_OWN_SLOT") ||
				access.slot < 0 ||
				access.slot >= site.slotCount ||
				stackObjectAccesses.has(action.ip)
			) {
				throw new Error(
					`Invalid stack-object access metadata at instruction ${action.ip}`,
				);
			}
			stackObjectAccesses.set(action.ip, { site, slot: access.slot });
		} else if (action.role === "inherited") {
			const instruction = fn.instructions[action.ip];
			if (
				planSite.inheritedAccessIp !== action.ip ||
				instruction?.opcode !== "LOAD_PROPERTY_STATIC" ||
				region.license.guard.dependencies.length === 0 ||
				site.inheritedLoadInstructionIndex !== undefined ||
				stackObjectInheritedAccesses.has(action.ip)
			) {
				throw new Error(
					`Invalid inherited stack-object access metadata at instruction ${action.ip}`,
				);
			}
			site.inheritedLoadInstructionIndex = action.ip;
			site.inheritedIcIndex = instruction.icIndex;
			site.inheritedFastName = `${site.objectName}_inherited_fast`;
			site.inheritedValueName = `${site.objectName}_inherited_value`;
			site.inheritedGuard = region.license.guard;
			stackObjectInheritedAccesses.set(action.ip, site);
		} else {
			throw new Error(`Invalid stack-object action ${action.role}`);
		}
	}
	const stringSplitProjectionSites = new Map<number, NativeStringSplitProjectionSite>();
	for (const projection of nativeContract.specializations.filter(
		(region): region is NativeStringSplitProjection =>
			region.kind === "string-split-projection",
	)) {
		const elementLoads = projection.loads
			.filter(
				(
					load,
				): load is NativeStringSplitProjection["loads"][number] & {
					kind: "element";
					index: number;
				} => load.kind === "element" && load.index !== undefined,
			)
			.sort((left, right) => left.index - right.index);
		if (
			elementLoads.length === 0 ||
			elementLoads.length > 8 ||
			stringSplitProjectionSites.has(projection.callIp)
		) {
			throw new Error(
				`Invalid Core string-split projection at instruction ${projection.callIp}`,
			);
		}
		stringSplitProjectionSites.set(projection.callIp, {
			projection,
			slotsOffset: nextStackSlot,
			elementLoads,
			lockedIdentity: projection.splitIdentity === "authority-invariant",
		});
		nextStackSlot += elementLoads.length;
	}
	const stringSplitCursorSites = new Map<number, NativeStringSplitCursorSite>();
	const stringSplitCursorRegions = nativeContract.specializations.filter(
		(region): region is NativeStringSplitCursor => region.kind === "string-split-cursor",
	);
	for (const cursor of stringSplitCursorRegions) {
		const callIp = cursor.anchors[0]!;
		const lengthIp = cursor.anchors[2]!;
		const backedgeIp = cursor.anchors[3]!;
		if (stringSplitCursorSites.has(callIp)) {
			throw new Error(`Duplicate Core string-split cursor at instruction ${callIp}`);
		}
		const hoistTrimIdentity = cursor.trimIdentity === "runtime-guarded";
		stringSplitCursorSites.set(callIp, {
			cursor,
			callIp,
			lengthIp,
			backedgeIp,
			subjectSlot: nextStackSlot,
			separatorSlot: nextStackSlot + 1,
			...(hoistTrimIdentity ? { trimCalleeSlot: nextStackSlot + 2 } : {}),
			semanticEpochStable: cursor.license.admission.mode === "stable",
			epochName: `__string_split_cursor_${callIp}_semantic_epoch`,
			lockedIdentity: cursor.splitIdentity === "authority-invariant",
			lockedTrimIdentity: cursor.trimIdentity === "authority-invariant",
		});
		nextStackSlot += hoistTrimIdentity ? 3 : 2;
	}
	const regexpExecProjectionSites = new Map<number, NativeRegExpExecProjectionSite>();
	for (const projection of nativeContract.specializations.filter(
		(region): region is Extract<VmRegion, { kind: "regexp-exec-projection" }> =>
			region.kind === "regexp-exec-projection",
	)) {
		const loads = [...projection.loads].sort(
			(left, right) => left.captureIndex - right.captureIndex,
		);
		if (
			loads.length === 0 ||
			loads.length > 8 ||
			regexpExecProjectionSites.has(projection.callIp) ||
			loads.some(
				(load, index) =>
					load.captureIndex <= 0 ||
					(index > 0 && loads[index - 1]!.captureIndex >= load.captureIndex),
			)
		) {
			throw new Error(
				`Invalid Core RegExp.exec projection at instruction ${projection.callIp}`,
			);
		}
		regexpExecProjectionSites.set(projection.callIp, {
			projection,
			subjectSlot: nextStackSlot,
			slotsOffset: nextStackSlot + 1,
			loads,
		});
		nextStackSlot += loads.length + 1;
	}
	const regexpIteratorProjectionSites = new Map<
		number,
		NativeRegExpIteratorProjectionSite
	>();
	for (const projection of nativeContract.specializations.filter(
		(region): region is Extract<VmRegion, { kind: "regexp-iterator-projection" }> =>
			region.kind === "regexp-iterator-projection",
	)) {
		const loads = [...projection.loads].sort(
			(left, right) => left.captureIndex - right.captureIndex,
		);
		if (
			loads.length === 0 ||
			loads.length > 8 ||
			regexpIteratorProjectionSites.has(projection.stepIp) ||
			loads.some(
				(load, index) =>
					load.captureIndex <= 0 ||
					(index > 0 && loads[index - 1]!.captureIndex >= load.captureIndex),
			)
		) {
			throw new Error(
				`Invalid Core RegExp iterator projection at instruction ${projection.stepIp}`,
			);
		}
		regexpIteratorProjectionSites.set(projection.stepIp, {
			projection,
			subjectSlot: nextStackSlot,
			slotsOffset: nextStackSlot + 1,
			loads,
		});
		nextStackSlot += loads.length + 1;
	}
	const fieldCalls = nativeContract.fieldCalls?.map((site): NativeFieldCall => {
		const allocation = fn.instructions[site.allocationIp];
		if (allocation?.opcode !== "CREATE_OBJECT_SHAPED")
			throw new Error("Invalid field call allocation");
		const numericKeys = new Set(
			site.entries.flatMap(
				(entry) =>
					directCompiledEntries.get(
						directCompiledEntryKey(entry.functionIndex, entry.entryId),
					)?.fieldParameters?.keys ?? [],
			),
		);
		const boxedSlots = allocation.keyStringIndices.map((key) =>
			numericKeys.has(key) ? undefined : nextStackSlot++,
		);
		return { ...site, allocation, boxedSlots };
	});
	const totalSlots = nextStackSlot;

	// `with` pushes an object environment record onto the `env` chain (WITH_ENTER),
	// so a with-function reassigns `env` and needs the root frame to keep the live
	// with-env rooted (the with-object is live across property accesses in the body).
	const hasWith = fn.instructions.some((i) => i.opcode === "WITH_ENTER");

	// A root frame is needed to scan MalValue registers, a derived constructor's
	// `this`, this activation's captured env, and/or a reassigned `with` env; every
	// exit past its link must unlink it.
	const needsRootFrame = totalSlots > 0 || capturesEnv || hasWith;
	const retainsForwardedArguments = fn.instructions.some(
		(instruction) => instruction.opcode === "CALL_REST_ARGUMENTS",
	);
	const gcUnlink =
		(retainsForwardedArguments ? "mal_gc_unroot(&__argument_roots); " : "") +
		(needsRootFrame ? "mal_root_frame_head = __gc_frame.prev; " : "");

	const profileDecisions: Array<BackendProfileDecision> = [];
	const body = emitBody(
		fn,
		index,
		nativeContract.specializations,
		nativeContract.regionActions,
		nativeContract.instructions,
		inactiveRootMasks,
		gcSafepointKinds,
		suffix,
		reps,
		debug,
		gcUnlink,
		thisSlot,
		null,
		stackObjectSites,
		stackObjectAccesses,
		stackObjectMaterializations,
		stackObjectInheritedAccesses,
		stringSplitProjectionSites,
		stringSplitCursorSites,
		regexpExecProjectionSites,
		regexpIteratorProjectionSites,
		directCompiledTargets,
		directCompiledEntries,
		directEntry?.resultRepresentation,
		vmSemanticProtectorGuard(semanticProtectors, "watched-methods"),
		profileDecisions,
		relocation,
		strictCompiledTargets,
		directEntry?.argumentRepresentations,
		new Map(
			directEntry?.constantBooleans?.map(({ instructionIp, value }) => [
				instructionIp,
				value,
			]),
		),
		directEntry?.fieldParameters,
		fieldCalls,
		nativeContract.literalSwitches,
		stringConstants,
	);
	if (body === null) {
		return null;
	}

	// Defensive: a register operand of -1 (a "no register" sentinel beyond the
	// RETURN case handled below) would emit invalid C like `r-1`. Bail to the
	// interpreter rather than emit broken code.
	if (body.lines.some((line) => /\br-\d/.test(line))) {
		return null;
	}

	const symbol =
		directEntry === undefined
			? `mal_compiled_${index}${suffix}`
			: `mal_direct_${index}_${directEntry.id}${suffix}`;
	const lines: Array<string> = [];

	const directParameters =
		directEntry === undefined
			? undefined
			: (directEntry.argumentRepresentations ?? directEntry.parameterRepresentations).map(
					(representation, parameter) => `${cTypeOf(representation)} p${parameter}`,
				);
	if (directEntry?.fieldParameters !== undefined)
		directParameters!.push(
			...directEntry.fieldParameters.keys.map((_, field) => `f64 fp${field}`),
		);
	lines.push(
		directEntry === undefined
			? `${linkage === "static" ? "static " : ""}MalValue ${symbol}(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalEnv *env, MalValue callee, void *entry_state) {`
			: `${linkage === "static" ? "static " : ""}${cTypeOf(directEntry.resultRepresentation)} ${symbol}(MalVm *vm, MalValue this_value${directParameters!.length === 0 ? "" : `, ${directParameters!.join(", ")}`}, MalEnv *env, MalValue callee) {`,
	);
	lines.push(`    (void) this_value;`);
	if (directEntry === undefined) lines.push(`    (void) new_target;`);
	lines.push(`    (void) env;`);
	lines.push(`    (void) callee;`);
	if (directEntry === undefined) {
		if (relocatable) {
			lines.push(
				`    const MalNativeProgramRelocation *__mal_relocation = &vm->compiler_native_relocation;`,
				`    (void) entry_state;`,
			);
		} else {
			lines.push(`    (void) entry_state;`);
		}
	}
	if (directEntry !== undefined && body.resources.has("newTarget")) {
		lines.push(`    const MalValue new_target = MAL_VALUE_UNDEFINED;`);
	}
	if (body.resources.has("propertyCache") || body.resources.has("literalShapes")) {
		const cacheMisses = [
			body.resources.has("propertyCache")
				? `vm->property_cache[${relocation.functionIndex(index)}].sites == nullptr`
				: undefined,
			body.resources.has("literalShapes")
				? `vm->literal_shape_cache[${relocation.functionIndex(index)}] == nullptr`
				: undefined,
		].filter((condition) => condition !== undefined);
		lines.push(
			`    if (__builtin_expect(${cacheMisses.join(" || ")}, 0)) {`,
			`        mal_vm_ensure_function_caches(vm, ${relocation.functionIndex(index)});`,
			`    }`,
		);
	}
	if (body.resources.has("propertyCache")) {
		lines.push(
			`    MalInlineCache *__property_ic = vm->property_cache[${relocation.functionIndex(index)}].sites;`,
		);
	}
	if (body.resources.has("literalShapes")) {
		lines.push(
			`    MalShape **__literal_shapes = vm->literal_shape_cache[${relocation.functionIndex(index)}];`,
		);
	}

	// Registers are plain C locals: `number`-rep ones as doubles, `boolean`-rep
	// as bool (both unboxed). MalValue-rep registers instead alias slots of the
	// root-frame array so the collector can scan them; the `#define` keeps the
	// `r<i>` spelling used throughout the body. The macros are #undef'd at the end
	// of the function (the batch path emits many functions into one unit).
	if (totalSlots > 0) {
		lines.push(`    MalValue __gc_slots[${totalSlots}];`);
	}
	for (const site of stackObjectSites.values()) {
		if (site.elided === true) continue;
		lines.push(`    MalObject ${site.objectName};`);
		if (site.scalarSlot !== undefined) {
			lines.push(
				`    ${cTypeOf(site.scalarSlot.representation)} ${site.scalarSlot.name};`,
			);
		}
		if (site.inheritedLoadInstructionIndex !== undefined) {
			lines.push(`    bool ${site.inheritedFastName} = false;`);
			lines.push(`    MalValue ${site.inheritedValueName} = MAL_VALUE_UNDEFINED;`);
		}
	}
	for (let i = 0; i < fn.registerCount; i++) {
		const slot = slotOf.get(i);
		if (slot !== undefined) {
			lines.push(`#define r${i} (__gc_slots[${slot}])`);
		} else {
			lines.push(`    ${cTypeOf(reps[i]!)} r${i};`);
		}
	}

	// Parameters adopt either the canonical boxed slice or the selected typed ABI;
	// non-parameter
	// registers start at a rep-appropriate zero.
	for (let i = 0; i < fn.parameterCount; i++) {
		lines.push(
			directEntry === undefined
				? `    r${i} = arg_count > ${i} ? args[${i}] : MAL_VALUE_UNDEFINED;`
				: directEntry.argumentRepresentations !== undefined &&
					  i >= directEntry.argumentRepresentations.length
					? `    r${i} = MAL_VALUE_UNDEFINED;`
					: `    r${i} = p${i};`,
		);
	}
	for (let i = fn.parameterCount; i < fn.registerCount; i++) {
		lines.push(`    r${i} = ${zeroOf(reps[i]!)};`);
	}
	if (fn.argumentSnapshotCount > 0) {
		lines.push(
			`    MAL_PERF_ADD(argument_snapshot_logical_values, ${fn.argumentSnapshotCount});`,
			`    MAL_PERF_ADD(argument_snapshot_destination_writes, ${fn.argumentSnapshotCount});`,
		);
	}
	// A derived constructor's rooted `this` slot starts as the (EMPTY) parameter.
	if (thisSlot >= 0) {
		lines.push(`    __gc_slots[${thisSlot}] = this_value;`);
	}
	// Stack-object slots are roots, not heap-object edges: initialize every slot
	// before publishing the frame, then keep the entire run rooted for the whole
	// activation (including calls, exceptions, and later loop iterations).
	for (let slot = stackSlotsBase; slot < totalSlots; slot++) {
		lines.push(`    __gc_slots[${slot}] = MAL_VALUE_UNDEFINED;`);
	}

	// Publish the root frame first, with every register slot already initialized,
	// so the collector can scan them before any allocation. mal_env_new is now a GC
	// allocation (MalEnv is a cell), so the env is built and linked into the
	// already-published frame afterwards — never held unrooted across a safepoint.
	if (needsRootFrame) {
		lines.push(
			`    ${relocatable ? "" : "static "}const MalFrameDescriptor __gc_desc = { .function_index = ${relocation.functionIndex(index)}, .slot_count = ${totalSlots} };`,
			`    MalRootFrame __gc_frame = { .prev = mal_root_frame_head, .desc = &__gc_desc, .slots = ${totalSlots > 0 ? "__gc_slots" : "nullptr"}, .inactive_slots = 0, .env = nullptr };`,
			`    mal_root_frame_head = &__gc_frame;`,
		);
	}

	if (retainsForwardedArguments) {
		// Elided rest arrays no longer root their elements across intervening calls.
		lines.push(
			"    MalRootSpan __argument_roots;",
			"    mal_gc_root(&__argument_roots, (MalValue *) args, arg_count);",
		);
	}

	// Allocate this activation's captured-slot env (mirroring the interpreter) and
	// reassign `env` so the body's LOAD/STORE_CAPTURED(self) and CREATE_FUNCTION use
	// it, then root it in the published frame. capturesEnv implies needsRootFrame.
	if (capturesEnv) {
		lines.push(
			`    env = mal_env_new(vm, env, ${relocation.functionIndex(index)}, ${fn.capturedCount});`,
			`    __gc_frame.env = env;`,
		);
	}

	for (const line of body.lines) {
		lines.push(line);
	}

	// Falling off the end returns undefined — or `this` for a constructor with no
	// explicit object return. A derived constructor routes through the checked
	// helper (returning before super() is a ReferenceError); everything else uses
	// mal_ops_construct_result (with new_target set for a [[Construct]] call).
	lines.push(
		directEntry !== undefined
			? `    ${gcUnlink}return ${zeroOf(directEntry.resultRepresentation)};`
			: thisSlot >= 0
				? `    ${gcUnlink}return mal_vm_op_derived_construct_return(vm, MAL_VALUE_UNDEFINED, __gc_slots[${thisSlot}]);`
				: !fn.hasPrototype
					? `    ${gcUnlink}return MAL_VALUE_UNDEFINED;`
					: `    ${gcUnlink}return mal_ops_construct_result(MAL_VALUE_UNDEFINED, this_value, new_target);`,
	);
	// Shared throw-exit: unlink the root frame and leave the compiled frame with the
	// throw pending (the dispatch caller observes vm->completion). Reached only by
	// `goto` from a no-handler throw; placed after the unconditional fall-off return
	// so control never falls into it. Omitted when nothing routes here.
	if (body.resources.has("throwExit")) {
		lines.push(
			`__throw_exit:;`,
			`    ${gcUnlink}return ${directEntry === undefined ? "MAL_VALUE_UNDEFINED" : zeroOf(directEntry.resultRepresentation)};`,
		);
	}
	lines.push("}");
	for (const i of valueRegs) {
		lines.push(`#undef r${i}`);
	}
	return {
		symbol,
		source: lines.join("\n"),
		profileDecisions,
		emittedInstructions: body.emittedInstructions,
		directEntryCalls: body.directEntryCalls,
		directEntries: [],
	};
}

function numericLeafWorker(
	fn: BytecodeFunction,
	entry: NativeDirectEntryPlan,
): Array<string> | null {
	if (
		fn.instructions.length > 48 ||
		fn.handlers.length > 0 ||
		fn.capturedCount > 0 ||
		fn.isGenerator ||
		fn.isAsync ||
		fn.isClassConstructor ||
		fn.mappedArguments ||
		entry.argumentRepresentations !== undefined ||
		entry.resultRepresentation !== "number"
	)
		return null;
	const reps = entry.registerRepresentations;
	const numeric = (r: number) => reps[r] === "number" || reps[r] === "int32";
	const scalar = (r: number) => numeric(r) || reps[r] === "boolean";
	const number = (r: number) => `(f64) r${r}`;
	const body: Array<string> = [];
	for (const [ip, op] of fn.instructions.entries()) {
		let line: string;
		switch (op.opcode) {
			case "JUMP":
			case "JUMP_IF":
				if (op.targetIp <= ip || op.targetIp >= fn.instructions.length) return null;
				if (op.opcode === "JUMP_IF" && reps[op.cond] !== "boolean") return null;
				line = `${op.opcode === "JUMP_IF" ? `if (r${op.cond}) ` : ""}goto L${op.targetIp};`;
				break;
			case "CREATE_NUMBER":
			case "CREATE_F64":
				if (!numeric(op.dst)) return null;
				line = `r${op.dst} = ${cF64Literal(op.value)};`;
				break;
			case "CREATE_BOOLEAN":
				if (reps[op.dst] !== "boolean") return null;
				line = `r${op.dst} = ${op.value};`;
				break;
			case "MOVE":
				if (!scalar(op.dst) || reps[op.dst] !== reps[op.src]) return null;
				line = `r${op.dst} = r${op.src};`;
				break;
			case "LOAD_PROPERTY_STATIC": {
				const field = entry.fieldParameters?.loads.find(
					(load) => load.instructionIp === ip,
				);
				if (field === undefined || reps[op.dst] !== "number") return null;
				line = `r${op.dst} = fp${field.field};`;
				break;
			}
			case "BINARY": {
				if (!numeric(op.left) || !numeric(op.right)) return null;
				const compare = NATIVE_COMPARE[op.operator];
				const expression =
					compare !== undefined && reps[op.dst] === "boolean"
						? `${number(op.left)} ${compare} ${number(op.right)}`
						: reps[op.dst] === "number"
							? nativeNumberExpr(op.operator, number(op.left), number(op.right))
							: null;
				if (expression === null) return null;
				line = `r${op.dst} = ${expression};`;
				break;
			}
			case "UNARY":
				if (
					!numeric(op.src) ||
					reps[op.dst] !== "number" ||
					!["+", "-", "tonumeric"].includes(op.operator)
				)
					return null;
				line = `r${op.dst} = ${op.operator === "-" ? "-" : ""}${number(op.src)};`;
				break;
			case "RETURN":
				if (!numeric(op.value)) return null;
				line = `return ${number(op.value)};`;
				break;
			default:
				return null;
		}
		body.push(`L${ip}:; ${line}`);
	}
	if (fn.instructions.at(-1)?.opcode !== "RETURN") return null;
	const declarations: Array<string> = [];
	for (const [r, rep] of reps.entries()) {
		if (!scalar(r)) continue;
		declarations.push(
			`${cTypeOf(rep)} r${r} = ${r < fn.parameterCount ? `p${r}` : "0"};`,
		);
	}
	return [...declarations, ...body];
}

/** Emit the canonical boxed entry and every independently lowerable typed sibling. */
export function emitCompiledFunction(
	fn: BytecodeFunction,
	native: NativeFunctionPlan,
	index: number,
	suffix: string,
	debug: boolean,
	linkage: "static" | "external" = "static",
	directCompiledTargets: ReadonlySet<number> = new Set(),
	semanticProtectors: ReadonlyArray<VmSemanticProtectorFact> = [],
	directCompiledEntries: DirectCompiledEntries = new Map(),
	relocatable = false,
	strictCompiledTargets: ReadonlySet<number> = new Set(),
	stringConstants: ReadonlyArray<ReadonlyArray<number>> = [],
): CompiledFunction | null {
	const canonical = emitCompiledVariant(
		fn,
		native,
		index,
		suffix,
		debug,
		linkage,
		directCompiledTargets,
		semanticProtectors,
		directCompiledEntries,
		relocatable,
		undefined,
		strictCompiledTargets,
		stringConstants,
	);
	if (relocatable) return canonical;
	if (canonical === null) return null;
	const variants = native.directEntries.flatMap<{
		entry: NativeDirectEntryPlan;
		emitted: CompiledFunction;
		leaf: true | undefined;
	}>((entry) => {
		const emitted = emitCompiledVariant(
			fn,
			native,
			index,
			suffix,
			debug,
			linkage,
			directCompiledTargets,
			semanticProtectors,
			directCompiledEntries,
			false,
			entry,
			strictCompiledTargets,
			stringConstants,
		);
		if (emitted === null) return [];
		const worker = debug ? null : numericLeafWorker(fn, entry);
		if (worker === null) return [{ entry, emitted, leaf: undefined }];
		const parameters = entry.parameterRepresentations
			.map((rep, i) => `${cTypeOf(rep)} p${i}`)
			.concat(entry.fieldParameters?.keys.map((_, i) => `f64 fp${i}`) ?? []);
		const args = entry.parameterRepresentations
			.map((_, i) => `p${i}`)
			.concat(entry.fieldParameters?.keys.map((_, i) => `fp${i}`) ?? []);
		const symbol = `${emitted.symbol}_leaf`;
		const source = `static f64 ${symbol}(${parameters.join(", ") || "void"}) {\n${worker.join("\n")}\n}\n${emitted.source.replace(
			" {\n",
			` {\n    if (mal_vm_leaf_unobserved(vm)) return ${symbol}(${args.join(", ")});\n`,
		)}`;
		return [{ entry, emitted: { ...emitted, source }, leaf: true as const }];
	});
	return {
		...canonical,
		directEntries: variants.map(({ entry, emitted, leaf }) => ({
			...(leaf === undefined ? {} : { leaf }),
			emittedInstructions: emitted.emittedInstructions,
			directEntryCalls: emitted.directEntryCalls,
			id: entry.id,
			symbol: emitted.symbol,
			source: emitted.source,
			parameterRepresentations: [
				...(entry.argumentRepresentations ?? entry.parameterRepresentations),
				...(entry.fieldParameters?.keys.map(() => "number" as const) ?? []),
			],
			resultRepresentation: entry.resultRepresentation,
		})),
	};
}

/**
 * Emit a resumable C function for a generator/async `fn`, or null when its body
 * uses an opcode the backend cannot lower yet (e.g. ASYNC_START/AWAIT before the
 * async milestone → async functions and async generators bail).
 *
 * The activation lives in a heap MalValue buffer (named __gc_slots so the shared
 * register/with-object emission works unchanged): registers [0,registerCount),
 * the with-object stack, then a self slot holding the coroutine object. A fresh
 * call allocates the buffer, runs the parameter prologue and body until the first
 * suspend; a resume restores the buffer + env from the coroutine and dispatches
 * to the saved resume label. Every register is boxed (no rep specialization: an
 * unboxed C local would not survive a suspend, and the resume ABI writes values
 * by register index).
 */
function emitResumableFunction(
	fn: BytecodeFunction,
	native: NativeFunctionPlan,
	index: number,
	suffix: string,
	debug: boolean,
	linkage: "static" | "external",
	semanticProtectors: ReadonlyArray<VmSemanticProtectorFact>,
	stringConstants: ReadonlyArray<ReadonlyArray<number>>,
): CompiledFunction | null {
	const isAsyncFunction = fn.isAsync && !fn.isGenerator;
	const isAsyncGenerator = fn.isAsync && fn.isGenerator;

	const reps: Array<RegisterRep> = new Array<RegisterRep>(fn.registerCount).fill("boxed");

	// Buffer layout: registers | coroutine self-reference. A `with` scope lives on
	// the env chain (gen->frame.env, saved/restored across suspend), not the buffer.
	const selfSlot = fn.registerCount;
	const totalSlots = fn.registerCount + 1;

	const capturesEnv = fn.capturedCount > 0;
	// The root frame spans the whole buffer and is always published, so every exit
	// past it must unlink it.
	const gcUnlink = "mal_root_frame_head = __gc_frame.prev; ";
	const argumentRetentionLimit = computeArgumentRetentionLimit(fn);
	const retainArguments =
		argumentRetentionLimit === 0x7fffffff
			? "arg_count > 0"
			: argumentRetentionLimit >= 0
				? `arg_count > 0 && arg_count <= ${argumentRetentionLimit}`
				: "false";

	const coro: CoroutineContext = {
		functionIndex: index,
		selfSlot,
		retainArguments,
		isAsyncFunction,
		isAsyncGenerator,
	};

	// thisSlot is -1: a coroutine is never a derived constructor, and `this` is read
	// from the this_value parameter (which the resume path is invoked with from the
	// saved frame), so no mutable this-slot is needed.
	const profileDecisions: Array<BackendProfileDecision> = [];
	const registerSlots = new Map<number, number>();
	for (let register = 0; register < fn.registerCount; register++) {
		registerSlots.set(register, register);
	}
	const body = emitBody(
		fn,
		index,
		native.specializations,
		native.regionActions,
		native.instructions,
		nativeInactiveRootMasks(native.gc.safepoints, registerSlots),
		new Map(
			native.gc.safepoints.map((safepoint) => [safepoint.instructionIp, safepoint.kind]),
		),
		suffix,
		reps,
		debug,
		gcUnlink,
		-1,
		coro,
		new Map(),
		new Map(),
		new Map(),
		new Map(),
		new Map(),
		new Map(),
		new Map(),
		new Map(),
		new Set(),
		new Map(),
		undefined,
		vmSemanticProtectorGuard(semanticProtectors, "watched-methods"),
		profileDecisions,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		stringConstants,
	);
	if (body === null) {
		return null;
	}
	if (body.lines.some((line) => /\br-\d/.test(line))) {
		return null;
	}
	// A resume dispatch jumps directly into `body`, so any function-wide state
	// declared at its head would otherwise be skipped and read uninitialized after
	// an await/yield. Reacquire the semantic epoch on every C invocation before the
	// dispatch; register-backed JavaScript state remains in the coroutine buffer.
	const resumablePreamble = body.invocationPreamble;

	const resumePoints = resumePointsOf(fn);
	const symbol = `mal_compiled_${index}${suffix}`;

	const lines: Array<string> = [];

	lines.push(
		`${linkage === "static" ? "static " : ""}MalValue ${symbol}(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalEnv *env, MalValue callee, void *entry_state) {`,
	);
	lines.push(`    (void) this_value;`);
	lines.push(`    (void) new_target;`);
	if (body.resources.has("propertyCache") || body.resources.has("literalShapes")) {
		const cacheMisses = [
			body.resources.has("propertyCache")
				? `vm->property_cache[${index}].sites == nullptr`
				: undefined,
			body.resources.has("literalShapes")
				? `vm->literal_shape_cache[${index}] == nullptr`
				: undefined,
		].filter((condition) => condition !== undefined);
		lines.push(
			`    if (__builtin_expect(${cacheMisses.join(" || ")}, 0)) {`,
			`        mal_vm_ensure_function_caches(vm, ${index});`,
			`    }`,
		);
	}
	if (body.resources.has("propertyCache")) {
		lines.push(`    MalInlineCache *__property_ic = vm->property_cache[${index}].sites;`);
	}
	if (body.resources.has("literalShapes")) {
		lines.push(`    MalShape **__literal_shapes = vm->literal_shape_cache[${index}];`);
	}
	lines.push(...resumablePreamble);

	lines.push(`    MalValue *__gc_slots;`);
	lines.push(
		`    MalGeneratorObject *resume_state = (MalGeneratorObject *) entry_state;`,
	);
	lines.push(`    MalGeneratorObject *__coro = resume_state;`);
	lines.push(`    (void) __coro;`);
	if (isAsyncFunction) {
		// The result promise the caller receives; created by ASYNC_START on the fresh
		// run and returned at every exit (ignored on a resume, where it is undefined).
		lines.push(`    MalValue __async_result_promise = MAL_VALUE_UNDEFINED;`);
	}
	for (let i = 0; i < fn.registerCount; i++) {
		lines.push(`#define r${i} (__gc_slots[${i}])`);
	}

	lines.push(
		`    static const MalFrameDescriptor __gc_desc = { .function_index = ${index}, .slot_count = ${totalSlots} };`,
		`    MalRootFrame __gc_frame;`,
	);

	// RESUME: restore buffer + env, publish the root frame over the buffer, dispatch
	// to the saved resume label. The sent value / resume mode were already written
	// into the buffer by index; a `with` env is restored via resume_state->frame.env.
	lines.push(`    if (resume_state != nullptr) {`);
	lines.push(`        __gc_slots = resume_state->frame.registers;`);
	lines.push(`        env = resume_state->frame.env;`);
	lines.push(`        args = resume_state->frame.arguments;`);
	lines.push(`        arg_count = resume_state->frame.argument_count;`);
	lines.push(`        callee = resume_state->frame.callee;`);
	lines.push(
		`        __gc_frame = (MalRootFrame){ .prev = mal_root_frame_head, .desc = &__gc_desc, .slots = __gc_slots, .inactive_slots = 0, .env = env };`,
	);
	lines.push(`        mal_root_frame_head = &__gc_frame;`);
	lines.push(`        switch (resume_state->frame.instruction_pointer) {`);
	for (const resumeIp of resumePoints) {
		lines.push(`        case ${resumeIp}: goto L${resumeIp};`);
	}
	// Unreachable: a saved resume IP is always one of the recorded points.
	lines.push(`        default: break;`);
	lines.push(`        }`);
	lines.push(`    } else {`);

	// FRESH: allocate the buffer (already all-undefined), publish the root frame,
	// build the captured env, then load parameters boxed before falling into body.
	lines.push(`        __gc_slots = mal_coroutine_alloc_registers(vm, ${totalSlots});`);
	lines.push(
		`        __gc_frame = (MalRootFrame){ .prev = mal_root_frame_head, .desc = &__gc_desc, .slots = __gc_slots, .inactive_slots = 0, .env = env };`,
	);
	lines.push(`        mal_root_frame_head = &__gc_frame;`);
	if (capturesEnv) {
		lines.push(
			`        env = mal_env_new(vm, env, ${index}, ${fn.capturedCount});`,
			`        __gc_frame.env = env;`,
		);
	}
	for (let i = 0; i < fn.parameterCount; i++) {
		lines.push(`        r${i} = arg_count > ${i} ? args[${i}] : MAL_VALUE_UNDEFINED;`);
	}
	if (fn.argumentSnapshotCount > 0) {
		lines.push(
			`        MAL_PERF_ADD(argument_snapshot_logical_values, ${fn.argumentSnapshotCount});`,
			`        MAL_PERF_ADD(argument_snapshot_destination_writes, ${fn.argumentSnapshotCount});`,
		);
	}
	lines.push(`    }`);

	for (const line of body.lines) {
		lines.push(line);
	}

	// Falling off the end is an implicit `return undefined` — complete the coroutine.
	const fallReturn = isAsyncFunction ? "__async_result_promise" : "MAL_VALUE_UNDEFINED";
	lines.push(
		`    mal_vm_op_coroutine_return_compiled(vm, __coro, MAL_VALUE_UNDEFINED);`,
		`    ${gcUnlink}return ${fallReturn};`,
	);
	// Shared throw-exit for a coroutine: complete the activation (free it, route the
	// throw by kind) before leaving the frame. __coro is null if the parameter
	// prologue threw before GENERATOR_START — then the raw buffer is released and the
	// throw propagates synchronously. Reached only by `goto`; omitted when unused.
	if (body.resources.has("throwExit")) {
		lines.push(
			`__throw_exit:;`,
			`    mal_vm_op_coroutine_throw_compiled(vm, __coro, __gc_slots); ${gcUnlink}return ${fallReturn};`,
		);
	}
	lines.push("}");
	for (let i = 0; i < fn.registerCount; i++) {
		lines.push(`#undef r${i}`);
	}

	return {
		symbol,
		source: lines.join("\n"),
		profileDecisions,
		emittedInstructions: body.emittedInstructions,
		directEntryCalls: body.directEntryCalls,
		directEntries: [],
	};
}

/** The C type a register of the given rep is held in. */
function cTypeOf(rep: RegisterRep): string {
	return rep === "int32"
		? "i32"
		: rep === "number"
			? "double"
			: rep === "boolean"
				? "bool"
				: "MalValue";
}

/** The zero/default value a register of the given rep is initialized to. */
function zeroOf(rep: RegisterRep): string {
	return rep === "int32"
		? "0"
		: rep === "number"
			? "0.0"
			: rep === "boolean"
				? "false"
				: "MAL_VALUE_UNDEFINED";
}

/**
 * Whether an instruction may synchronously run JavaScript and therefore mutate
 * a watched semantic family.
 * Allocation and GC are safe: this runtime's collector does not run finalizers or
 * jobs inside a safepoint. Unknown instructions fail closed.
 */
type NativeStringSplitProjection = Extract<VmRegion, { kind: "string-split-projection" }>;

interface NativeStringSplitProjectionSite {
	projection: NativeStringSplitProjection;
	slotsOffset: number;
	lockedIdentity: boolean;
	elementLoads: Array<
		NativeStringSplitProjection["loads"][number] & {
			kind: "element";
			index: number;
		}
	>;
}

interface NativeStringSplitProjectionAction {
	site: NativeStringSplitProjectionSite;
	role: "property" | "call" | "element" | "length";
	load?: NativeStringSplitProjection["loads"][number];
	propertyLoad?: Extract<BytecodeInstruction, { opcode: "LOAD_PROPERTY_STATIC" }>;
}

type NativeStringSplitCursor = Extract<VmRegion, { kind: "string-split-cursor" }>;

interface NativeStringSplitCursorSite {
	cursor: NativeStringSplitCursor;
	callIp: number;
	lengthIp: number;
	backedgeIp: number;
	subjectSlot: number;
	separatorSlot: number;
	trimCalleeSlot?: number;
	/** Core proved the admitted semantic epochs stable across every licensed use. */
	semanticEpochStable: boolean;
	epochName: string;
	lockedIdentity: boolean;
	lockedTrimIdentity: boolean;
}

interface NativeStringSplitCursorAction {
	site: NativeStringSplitCursorSite;
	role: "property" | "call" | "length" | "element" | "trimProperty" | "trimCall";
	propertyLoad?: Extract<BytecodeInstruction, { opcode: "LOAD_PROPERTY_STATIC" }>;
}

type NativeRegExpExecProjection = Extract<VmRegion, { kind: "regexp-exec-projection" }>;

interface NativeRegExpExecProjectionSite {
	projection: NativeRegExpExecProjection;
	subjectSlot: number;
	slotsOffset: number;
	loads: Array<NativeRegExpExecProjection["loads"][number]>;
}

interface NativeRegExpExecProjectionAction {
	site: NativeRegExpExecProjectionSite;
	role:
		| "property"
		| "call"
		| "capture"
		| "length"
		| "charCodeAtProperty"
		| "charCodeAtCall"
		| "number"
		| "caseUpperProperty"
		| "caseUpperCall"
		| "caseLowerProperty"
		| "caseLowerCall"
		| "caseLength";
	load?: NativeRegExpExecProjection["loads"][number];
	propertyLoad?: Extract<BytecodeInstruction, { opcode: "LOAD_PROPERTY_STATIC" }>;
}

type NativeRegExpIteratorProjection = Extract<
	VmRegion,
	{ kind: "regexp-iterator-projection" }
>;

interface NativeRegExpIteratorProjectionSite {
	projection: NativeRegExpIteratorProjection;
	subjectSlot: number;
	slotsOffset: number;
	loads: Array<NativeRegExpIteratorProjection["loads"][number]>;
}

interface NativeRegExpIteratorProjectionAction {
	site: NativeRegExpIteratorProjectionSite;
	role: "step" | "capture" | "number";
	load?: NativeRegExpIteratorProjection["loads"][number];
}

type NativeStringSliceNumberFusion = Extract<VmRegion, { kind: "string-slice-number" }>;

interface NativeStringSliceNumberFusionAction {
	fusion: NativeStringSliceNumberFusion;
	role: "property" | "slice" | "number";
	lockedIdentity: boolean;
	propertyLoad?: Extract<BytecodeInstruction, { opcode: "LOAD_PROPERTY_STATIC" }>;
}

type NativeStringCharCodeAtChain = Extract<
	VmRegion,
	{ kind: "string-char-code-at-chain" }
>;

interface NativeStringCharCodeAtChainAction {
	readonly chain: NativeStringCharCodeAtChain;
	readonly role: "property" | "call";
}

type NativeBuiltinCollectionCallChain = Extract<
	VmRegion,
	{ kind: "builtin-collection-call-chain" }
>;

interface NativeBuiltinCollectionCallChainAction {
	readonly chain: NativeBuiltinCollectionCallChain;
	readonly role: "property" | "call";
}

function nativeBuiltinCollectionOperation(
	operation: NativeBuiltinCollectionCallChain["operation"],
): string {
	return {
		"Map.prototype.get": "MAL_GUARDED_BUILTIN_MAP_GET",
		"Map.prototype.set": "MAL_GUARDED_BUILTIN_MAP_SET",
		"Map.prototype.has": "MAL_GUARDED_BUILTIN_MAP_HAS",
		"Map.prototype.delete": "MAL_GUARDED_BUILTIN_MAP_DELETE",
		"Set.prototype.add": "MAL_GUARDED_BUILTIN_SET_ADD",
		"Set.prototype.has": "MAL_GUARDED_BUILTIN_SET_HAS",
		"Set.prototype.delete": "MAL_GUARDED_BUILTIN_SET_DELETE",
	}[operation];
}

type NativeIteratorCursor = Extract<
	VmRegion,
	{
		kind:
			| "array-values-iterator-cursor"
			| "string-iterator-cursor"
			| "typed-array-iterator-cursor"
			| "map-iterator-cursor"
			| "set-iterator-cursor";
	}
>;

interface NativeIteratorCursorAction {
	readonly cursor: NativeIteratorCursor;
	readonly role: "initialize" | "step";
}

interface NativeArrayPairDestructureAction {
	readonly cursor: Extract<
		NativeIteratorCursor,
		{ readonly kind: "array-values-iterator-cursor" }
	>;
	readonly role: "initialize" | "step" | "close";
	readonly index?: 0 | 1;
}

interface NativeIteratorResultVirtualizationAction {
	readonly region: Extract<VmRegion, { kind: "iterator-result-virtualization" }>;
}

type NativeIteratorEntryPairVirtualization = Extract<
	VmRegion,
	{ kind: "iterator-entry-pair-virtualization" }
>;

interface NativeIteratorEntryPairVirtualizationAction {
	readonly region: NativeIteratorEntryPairVirtualization;
	readonly role: "outerStep" | "innerInitialize" | "innerStep" | "innerClose";
	readonly index?: number;
}

function nativeIteratorCursorProtocol(cursor: NativeIteratorCursor): string {
	switch (cursor.protocol) {
		case "array-values":
			return "MAL_ITERATOR_CURSOR_ARRAY_VALUES";
		case "string":
			return "MAL_ITERATOR_CURSOR_STRING_VALUES";
		case "typed-array-values":
			return "MAL_ITERATOR_CURSOR_TYPED_ARRAY_VALUES";
		case "map":
			return "MAL_ITERATOR_CURSOR_MAP";
		case "set":
			return "MAL_ITERATOR_CURSOR_SET";
	}
}

interface StackObjectSite {
	objectName: string;
	elided?: true;
	slotsOffset?: number;
	slotCount: number;
	scalarSlot?: {
		readonly name: string;
		readonly representation: "int32" | "number" | "boolean";
	};
	inheritedLoadInstructionIndex?: number;
	inheritedIcIndex?: number;
	inheritedFastName?: string;
	inheritedValueName?: string;
	inheritedGuard?: VmGuardPlan;
}

function stackObjectScalarSlotRepresentation(
	fn: BytecodeFunction,
	native: NativeFunctionPlan,
	region: VmStackObjectPlanRegion,
	site: VmStackObjectPlanRegion["sites"][number],
): "int32" | "number" | "boolean" | undefined {
	if (
		region.license.materialization !== "none" ||
		site.slotCount !== 1 ||
		site.inheritedAccessIp !== undefined ||
		site.materializations.length !== 0
	) {
		return undefined;
	}
	const allocation = fn.instructions[site.allocationIp];
	if (allocation?.opcode !== "CREATE_OBJECT_SHAPED") return undefined;
	const initial = allocation.valueRegisters[0];
	const representation =
		initial === undefined ? undefined : native.registerRepresentations[initial];
	if (
		representation !== "int32" &&
		representation !== "number" &&
		representation !== "boolean"
	) {
		return undefined;
	}
	for (const access of site.accesses) {
		if (access.slot !== 0) return undefined;
		const instruction = fn.instructions[access.ip];
		const register =
			instruction?.opcode === "LOAD_PROPERTY_STATIC" ||
			instruction?.opcode === "LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT"
				? instruction.dst
				: instruction?.opcode === "STORE_PROPERTY_STATIC" ||
					  instruction?.opcode === "STORE_PROPERTY_STATIC_KNOWN_OWN_SLOT"
					? instruction.value
					: undefined;
		if (
			register === undefined ||
			native.registerRepresentations[register] !== representation
		) {
			return undefined;
		}
	}
	return representation;
}

function stackObjectSlotReference(site: StackObjectSite, slot: number): string {
	if (site.scalarSlot !== undefined) {
		if (slot !== 0) throw new Error("Scalar stack-object storage names only slot zero");
		return site.scalarSlot.name;
	}
	if (site.slotsOffset === undefined) throw new Error("Stack object lacks slot storage");
	return `__gc_slots[${site.slotsOffset + slot}]`;
}

function semanticDependencyMask(
	dependencies: ReadonlyArray<VmSemanticDependency>,
): string | undefined {
	const masks = new Set<string>();
	for (const dependency of dependencies) {
		if (dependency.kind === "world") continue;
		switch (dependency.family) {
			case "primitive-methods":
				masks.add("MAL_SEMANTIC_DEPENDENCY_PRIMITIVE_METHODS");
				break;
			case "watched-methods":
				masks.add("MAL_SEMANTIC_DEPENDENCY_WATCHED_METHODS");
				break;
			case "array-elements":
				masks.add("MAL_SEMANTIC_DEPENDENCY_ARRAY_ELEMENTS");
				break;
			case "global-bindings":
			case "object-shapes":
				throw new Error(`Unsupported native semantic dependency ${dependency.family}`);
		}
	}
	return masks.size === 0 ? undefined : [...masks].sort().join(" | ");
}

/** Translate named epoch dependencies only through the shared runtime bridge. */
function semanticDependencyAdmissionGuard(
	guard: VmGuardPlan,
	activityEpochName?: string,
): string {
	const mask = semanticDependencyMask(guard.dependencies);
	if (mask === undefined) return "true";
	return `mal_vm_semantic_dependencies_admit(vm, ${mask}, ${activityEpochName === undefined ? "nullptr" : `&${activityEpochName}`})`;
}

function semanticDependencyValidationGuard(
	guard: VmGuardPlan,
	activityEpochName: string,
): string {
	const mask = semanticDependencyMask(guard.dependencies);
	if (mask === undefined) return "true";
	return `mal_vm_semantic_dependencies_validate(vm, ${mask}, ${activityEpochName})`;
}

/**
 * Translate one named region license at its admission point. Local brand,
 * callback, shape, and argument checks stay beside the runtime protocol; this
 * function owns only shared semantic dependencies and verifies that a generic
 * twin exists before C emission may consume them.
 */
function regionAdmissionGuard(
	license: VmRegionLicense,
	activityEpochName?: string,
): string {
	if (
		license.genericTwin !== "retained" ||
		!license.guard.obligations.includes("fallback")
	) {
		throw new Error("Speculative region lacks its generic twin");
	}
	if (
		license.materialization !== "none" &&
		!license.guard.obligations.includes("materialize")
	) {
		throw new Error("Virtual region lacks its materialization contract");
	}
	return semanticDependencyAdmissionGuard(license.guard, activityEpochName);
}

function inheritedStackObjectProtectorGuard(site: StackObjectSite): string {
	const guard = site.inheritedGuard;
	if (
		guard === undefined ||
		!guard.obligations.includes("fallback") ||
		!guard.obligations.includes("materialize")
	) {
		throw new Error("Inherited stack-object site lacks its fallback contract");
	}
	return semanticDependencyAdmissionGuard(guard);
}

interface NativeNumericFusionAction {
	readonly role: "start" | "finish";
	readonly id: number;
	readonly first: Extract<BytecodeInstruction, { opcode: "BINARY" }>;
}

interface IndexedLengthLoopAction {
	readonly loadIp: number;
	readonly role: "load" | "compare" | "coerce" | "update" | "element";
	readonly site: Extract<VmRegion, { kind: "indexed-length-loop" }>["sites"][number];
	readonly element?: Extract<
		VmRegion,
		{ kind: "indexed-length-loop" }
	>["sites"][number]["elements"][number];
}

interface NativeArrayPresenceProjectionAction {
	readonly role: "membership" | "load";
	readonly membershipIp: number;
	readonly indexed: IndexedLengthLoopAction;
}

type NativeBodyResource = "propertyCache" | "literalShapes" | "newTarget" | "throwExit";

interface EmittedBody extends NativeCallCoverage {
	readonly lines: Array<string>;
	readonly invocationPreamble: Array<string>;
	readonly resources: ReadonlySet<NativeBodyResource>;
}

const NATIVE_BODY_REFERENCES: Readonly<Record<NativeBodyResource, string>> = {
	propertyCache: "__property_ic",
	literalShapes: "__literal_shapes",
	newTarget: "new_target",
	throwExit: "__throw_exit",
};

function nativeBodyReference(
	resources: Set<NativeBodyResource>,
	resource: NativeBodyResource,
): string {
	resources.add(resource);
	return NATIVE_BODY_REFERENCES[resource];
}

function emitStringSwitch(
	site: Extract<
		NonNullable<NativeFunctionPlan["literalSwitches"]>[number],
		{ kind: "string" }
	>,
	stringConstants: ReadonlyArray<ReadonlyArray<number>>,
	suffix: string,
	representation: RegisterRep,
	relocation: NativeRelocationExpressions,
	branch: (target: number, branchIp: number) => string,
):
	| {
			lines: Array<string>;
			strategy: "direct" | "length" | "hash" | "non-string";
	  }
	| undefined {
	const fallback = branch(site.defaultIp, site.endIp);
	if (representation !== "boxed" && representation !== "string")
		return { lines: [fallback], strategy: "non-string" };
	const labels: Array<{
		stringIndex: number;
		codeUnits: ReadonlyArray<number>;
		targetIp: number;
		branchIp: number;
	}> = [];
	const seen = new Set<number>();
	let totalCodeUnits = 0;
	let minLength = Infinity;
	let maxLength = 0;
	for (const [index, label] of site.cases.entries()) {
		const codeUnits = stringConstants[label.stringIndex];
		if (codeUnits === undefined) return undefined;
		totalCodeUnits += codeUnits.length;
		if (totalCodeUnits > NATIVE_STRING_SWITCH_CODE_UNIT_LIMIT) return undefined;
		if (seen.has(label.stringIndex)) continue;
		seen.add(label.stringIndex);
		minLength = Math.min(minLength, codeUnits.length);
		maxLength = Math.max(maxLength, codeUnits.length);
		labels.push({
			...label,
			codeUnits,
			branchIp: site.instructionIp + index * 3 + 2,
		});
	}
	const lengths = new Map<number, Array<(typeof labels)[number]>>();
	let largestLengthGroup = 0;
	for (const label of labels) {
		const length = label.codeUnits.length;
		let group = lengths.get(length);
		if (group === undefined) lengths.set(length, (group = []));
		group.push(label);
		largestLengthGroup = Math.max(largestLengthGroup, group.length);
	}
	const strategy =
		labels.length <= 3
			? "direct"
			: lengths.size > 1 && largestLengthGroup <= 3
				? "length"
				: labels.length >= 8
					? "hash"
					: "direct";
	const value = `__switch_${site.instructionIp}`;
	const lines: Array<string> = [];
	if (representation === "boxed")
		lines.push(`if (!mal_value_is_string(r${site.selector})) { ${fallback} }`);
	lines.push(`MalString *${value} = mal_value_to_string(r${site.selector});`);
	const compare = (label: (typeof labels)[number]) =>
		`if (mal_string_equals(${value}, mal_value_to_string(${relocation.stringValue(label.stringIndex, suffix)}))) { ${branch(label.targetIp, label.branchIp)} }`;
	if (strategy === "direct") {
		for (const label of labels) lines.push(compare(label));
	} else {
		const groups =
			strategy === "length" ? lengths : new Map<number, Array<(typeof labels)[number]>>();
		if (strategy === "hash") {
			for (const label of labels) {
				const hash = nativeStringSwitchHash(label.codeUnits);
				let group = groups.get(hash);
				if (group === undefined) groups.set(hash, (group = []));
				group.push(label);
			}
			// Bound rope flattening when hashing an unknown selector that cannot match a literal.
			lines.push(
				`if (${value}->length < ${minLength} || ${value}->length > ${maxLength}) { ${fallback} }`,
			);
		}
		lines.push(
			`switch (${strategy === "length" ? `${value}->length` : `(u32) mal_string_hash(${value})`}) {`,
		);
		for (const [key, group] of groups) {
			lines.push(`case ${key}U:`);
			for (const label of group) lines.push(compare(label));
			lines.push("break;");
		}
		lines.push("}");
	}
	lines.push(fallback);
	return { lines, strategy };
}

function stringConstantIsArrayIndex(units: ReadonlyArray<number>): boolean {
	if (units.length === 0) return false;
	if (units[0] === 0x30) return units.length === 1;
	if (units[0]! < 0x31 || units[0]! > 0x39) return false;
	let index = 0;
	for (const unit of units) {
		if (unit < 0x30 || unit > 0x39) return false;
		index = index * 10 + unit - 0x30;
		if (index > 0xffff_fffe) return false;
	}
	return true;
}

/**
 * Emit the instruction body, with labels at jump targets and gotos for jumps.
 * Returns null if any instruction is not yet lowerable.
 */
function emitBody(
	fn: BytecodeFunction,
	functionIndex: number,
	specializations: ReadonlyArray<VmRegion>,
	regionActions: ReadonlyArray<VmRegionAction>,
	nativeInstructions: ReadonlyArray<NativeInstructionPlan | undefined>,
	inactiveRootMasks: ReadonlyMap<number, bigint>,
	gcSafepointKinds: ReadonlyMap<
		number,
		NativeFunctionPlan["gc"]["safepoints"][number]["kind"]
	>,
	suffix: string,
	reps: Array<RegisterRep>,
	debug: boolean,
	gcUnlink: string,
	thisSlot: number,
	coro: CoroutineContext | null,
	stackObjectSites: ReadonlyMap<number, StackObjectSite>,
	stackObjectAccesses: ReadonlyMap<number, { site: StackObjectSite; slot: number }>,
	stackObjectMaterializations: ReadonlyMap<number, StackObjectSite>,
	stackObjectInheritedAccesses: ReadonlyMap<number, StackObjectSite>,
	stringSplitProjectionSites: ReadonlyMap<number, NativeStringSplitProjectionSite>,
	stringSplitCursorSites: ReadonlyMap<number, NativeStringSplitCursorSite>,
	regexpExecProjectionSites: ReadonlyMap<number, NativeRegExpExecProjectionSite>,
	regexpIteratorProjectionSites: ReadonlyMap<number, NativeRegExpIteratorProjectionSite>,
	directCompiledTargets: ReadonlySet<number>,
	directCompiledEntries: DirectCompiledEntries,
	directResultRepresentation: VmRegisterRepresentation | undefined,
	watchedMethodsGuard: VmGuardPlan | undefined,
	profileDecisions: Array<BackendProfileDecision>,
	relocation: NativeRelocationExpressions = nativeRelocationExpressions(false),
	strictCompiledTargets: ReadonlySet<number> = new Set(),
	directArgumentRepresentations?: ReadonlyArray<VmRegisterRepresentation>,
	directConstantBooleans: ReadonlyMap<number, boolean> = new Map(),
	directFields?: NativeDirectEntryPlan["fieldParameters"],
	fieldCalls?: ReadonlyArray<NativeFieldCall>,
	literalSwitches?: NativeFunctionPlan["literalSwitches"],
	stringConstants: ReadonlyArray<ReadonlyArray<number>> = [],
): EmittedBody | null {
	if (!vmRegionActionsAreCurrent(specializations, regionActions)) {
		throw new Error("Native function has stale region actions");
	}
	const numericFusionActionByIp = new Map<number, NativeNumericFusionAction>();
	for (const action of regionActions) {
		const region = specializations[action.regionIndex];
		if (region?.kind !== "numeric-fusion") continue;
		const pair = region.pairs[action.primaryIndex ?? -1];
		if (pair === undefined || (action.role !== "start" && action.role !== "finish")) {
			throw new Error("Invalid numeric-fusion action");
		}
		const first = fn.instructions[pair.firstIp];
		const finish = fn.instructions[pair.finishIp];
		if (
			first?.opcode !== "BINARY" ||
			finish?.opcode !== "BINARY" ||
			action.ip !== (action.role === "start" ? pair.firstIp : pair.finishIp) ||
			numericFusionActionByIp.has(action.ip)
		) {
			throw new Error("Invalid numeric-fusion region");
		}
		if (
			nativeInstructions[pair.firstIp]?.kind === "unsigned-arithmetic" ||
			nativeInstructions[pair.finishIp]?.kind === "unsigned-arithmetic"
		)
			continue;
		const common = { id: pair.firstIp, first };
		numericFusionActionByIp.set(action.ip, { ...common, role: action.role });
	}
	const indexedLengthLoopActionByIp = new Map<number, IndexedLengthLoopAction>();
	for (const action of regionActions) {
		const region = specializations[action.regionIndex];
		if (region?.kind !== "indexed-length-loop") continue;
		const site = region.sites[action.primaryIndex ?? -1];
		if (
			site === undefined ||
			(action.role !== "load" &&
				action.role !== "compare" &&
				action.role !== "coerce" &&
				action.role !== "update" &&
				action.role !== "element")
		) {
			throw new Error("Invalid indexed-length-loop action");
		}
		const load = fn.instructions[site.loadIp];
		const comparison = fn.instructions[site.comparisonIp];
		const element =
			action.role === "element" ? site.elements[action.secondaryIndex ?? -1] : undefined;
		const length =
			comparison?.opcode === "BINARY"
				? site.lengthPosition === 1
					? comparison.left
					: comparison.right
				: -1;
		const other =
			comparison?.opcode === "BINARY"
				? site.lengthPosition === 1
					? comparison.right
					: comparison.left
				: -1;
		const elementInstruction =
			element === undefined ? undefined : fn.instructions[element.ip];
		const indexedInstruction =
			element?.indexIp === undefined ? undefined : fn.instructions[element.indexIp];
		const reverse = site.reverseInduction;
		const coercion =
			reverse === undefined ? undefined : fn.instructions[reverse.coercionIp];
		const update = reverse === undefined ? undefined : fn.instructions[reverse.updateIp];
		if (
			load?.opcode !== "LOAD_PROPERTY_STATIC" ||
			comparison?.opcode !== "BINARY" ||
			!["<", "<=", ">", ">=", "==", "!=", "===", "!=="].includes(comparison.operator) ||
			(reverse === undefined
				? length !== load.dst
				: comparison.operator !== ">" ||
					coercion?.opcode !== "UNARY" ||
					coercion.operator !== "tonumeric" ||
					update?.opcode !== "UNARY" ||
					update.operator !== "decrement" ||
					coercion.dst !== update.src ||
					update.dst !== length) ||
			(action.role === "element"
				? element === undefined ||
					typeof element.arrayIndexIsUint32 !== "boolean" ||
					(element.kind === "load"
						? elementInstruction?.opcode !== "LOAD_PROPERTY"
						: elementInstruction?.opcode !== "STORE_PROPERTY") ||
					(elementInstruction?.opcode === "LOAD_PROPERTY" ||
					elementInstruction?.opcode === "STORE_PROPERTY"
						? elementInstruction.object !== load.object ||
							(reverse === undefined
								? elementInstruction.key !== other
								: element.indexIp === undefined
									? elementInstruction.key !== length
									: indexedInstruction?.opcode !== "BINARY" ||
										indexedInstruction.operator !== "-" ||
										indexedInstruction.left !== length ||
										elementInstruction.key !== indexedInstruction.dst)
						: true)
				: element !== undefined) ||
			((action.role === "coerce" || action.role === "update") && reverse === undefined) ||
			(element?.arrayIndexIsUint32 === true &&
				!(
					reverse === undefined &&
					((site.lengthPosition === 1 && comparison.operator === ">") ||
						(site.lengthPosition === 2 && comparison.operator === "<"))
				)) ||
			action.ip !==
				(action.role === "load"
					? site.loadIp
					: action.role === "compare"
						? site.comparisonIp
						: action.role === "coerce"
							? reverse!.coercionIp
							: action.role === "update"
								? reverse!.updateIp
								: element!.ip) ||
			indexedLengthLoopActionByIp.has(action.ip)
		) {
			throw new Error("Invalid indexed-length-loop region");
		}
		indexedLengthLoopActionByIp.set(action.ip, {
			loadIp: site.loadIp,
			role: action.role,
			site,
			...(element === undefined ? {} : { element }),
		});
	}
	const nativeArrayPresenceProjectionActionByIp = new Map<
		number,
		NativeArrayPresenceProjectionAction
	>();
	for (const indexed of indexedLengthLoopActionByIp.values()) {
		if (
			indexed.role !== "element" ||
			indexed.element?.kind !== "load" ||
			indexed.element.arrayIndexIsUint32 !== true
		)
			continue;
		const loadIp = indexed.element.ip;
		const membershipIp = loadIp - 3;
		const membership = fn.instructions[membershipIp];
		const branch = fn.instructions[membershipIp + 1];
		const skip = fn.instructions[membershipIp + 2];
		const load = fn.instructions[loadIp];
		if (
			membership?.opcode !== "BINARY" ||
			membership.operator !== "in" ||
			branch?.opcode !== "JUMP_IF" ||
			branch.cond !== membership.dst ||
			branch.targetIp !== loadIp ||
			skip?.opcode !== "JUMP" ||
			load?.opcode !== "LOAD_PROPERTY" ||
			membership.left !== load.key ||
			membership.right !== load.object ||
			fn.instructions.some(
				(candidate) =>
					(candidate.opcode === "JUMP" || candidate.opcode === "JUMP_IF") &&
					(candidate.targetIp === membershipIp + 1 ||
						candidate.targetIp === membershipIp + 2),
			)
		)
			continue;
		nativeArrayPresenceProjectionActionByIp.set(membershipIp, {
			role: "membership",
			membershipIp,
			indexed,
		});
		nativeArrayPresenceProjectionActionByIp.set(loadIp, {
			role: "load",
			membershipIp,
			indexed,
		});
	}
	const nativeStringCharCodeAtChainActionByIp = new Map<
		number,
		NativeStringCharCodeAtChainAction
	>();
	const nativeBuiltinCollectionCallChainActionByIp = new Map<
		number,
		NativeBuiltinCollectionCallChainAction
	>();
	for (const action of regionActions) {
		const chain = specializations[action.regionIndex];
		if (chain?.kind === "string-char-code-at-chain") {
			if (
				(action.role !== "property" && action.role !== "call") ||
				action.ip !== (action.role === "property" ? chain.propertyIp : chain.callIp) ||
				nativeStringCharCodeAtChainActionByIp.has(action.ip)
			) {
				throw new Error("Duplicate String.charCodeAt chain action");
			}
			nativeStringCharCodeAtChainActionByIp.set(action.ip, {
				chain,
				role: action.role,
			});
		} else if (chain?.kind === "builtin-collection-call-chain") {
			if (
				(action.role !== "property" && action.role !== "call") ||
				action.ip !== (action.role === "property" ? chain.propertyIp : chain.callIp) ||
				nativeBuiltinCollectionCallChainActionByIp.has(action.ip)
			) {
				throw new Error("Duplicate collection call-chain action");
			}
			nativeBuiltinCollectionCallChainActionByIp.set(action.ip, {
				chain,
				role: action.role,
			});
		}
	}
	const nativeIteratorCursorActionByIp = new Map<number, NativeIteratorCursorAction>();
	const nativeIteratorResultVirtualizationActionByIp = new Map<
		number,
		NativeIteratorResultVirtualizationAction
	>();
	const nativeIteratorEntryPairVirtualizationActionByIp = new Map<
		number,
		NativeIteratorEntryPairVirtualizationAction
	>();
	for (const action of regionActions) {
		const region = specializations[action.regionIndex];
		if (region === undefined) throw new Error("Native region action names no region");
		if (
			region.kind === "array-values-iterator-cursor" ||
			region.kind === "string-iterator-cursor" ||
			region.kind === "typed-array-iterator-cursor" ||
			region.kind === "map-iterator-cursor" ||
			region.kind === "set-iterator-cursor"
		) {
			if (
				(action.role !== "initialize" && action.role !== "step") ||
				action.ip !==
					(action.role === "initialize"
						? region.initializeIp
						: region.stepIps[action.primaryIndex ?? -1]) ||
				nativeIteratorCursorActionByIp.has(action.ip)
			) {
				throw new Error("Duplicate iterator cursor action");
			}
			nativeIteratorCursorActionByIp.set(action.ip, {
				cursor: region,
				role: action.role,
			});
		} else if (region.kind === "iterator-result-virtualization") {
			if (
				action.role !== "step" ||
				action.ip !== region.stepIps[action.primaryIndex ?? -1] ||
				nativeIteratorResultVirtualizationActionByIp.has(action.ip)
			) {
				throw new Error("Duplicate iterator-result virtualization action");
			}
			nativeIteratorResultVirtualizationActionByIp.set(action.ip, { region });
		} else if (region.kind === "iterator-entry-pair-virtualization") {
			const index = action.primaryIndex;
			const valid =
				(action.role === "outerStep" && action.ip === region.outerStepIp) ||
				(action.role === "innerInitialize" && action.ip === region.innerInitializeIp) ||
				(action.role === "innerStep" && action.ip === region.innerStepIps[index ?? -1]) ||
				(action.role === "innerClose" && action.ip === region.innerCloseIps[index ?? -1]);
			if (!valid || nativeIteratorEntryPairVirtualizationActionByIp.has(action.ip)) {
				throw new Error("Duplicate iterator entry-pair virtualization action");
			}
			nativeIteratorEntryPairVirtualizationActionByIp.set(action.ip, {
				region,
				role: action.role,
				...(index === undefined ? {} : { index }),
			});
		}
	}
	const nativeArrayPairDestructureActionByIp = new Map<
		number,
		NativeArrayPairDestructureAction
	>();
	for (const action of nativeIteratorCursorActionByIp.values()) {
		const cursor = action.cursor;
		if (
			action.role !== "initialize" ||
			cursor.kind !== "array-values-iterator-cursor" ||
			cursor.stepIps.length !== 2
		) {
			continue;
		}
		const [firstStepIp, secondStepIp] = cursor.stepIps as [number, number];
		const firstStep = fn.instructions[firstStepIp];
		const secondStep = fn.instructions[secondStepIp];
		const branch = fn.instructions[secondStepIp + 1];
		const closeJump = fn.instructions[secondStepIp + 2];
		const closeIp = secondStepIp + 3;
		const close = fn.instructions[closeIp];
		const afterClose = fn.instructions[secondStepIp + 4];
		const continuationIp = secondStepIp + 5;
		if (
			firstStepIp !== cursor.initializeIp + 1 ||
			secondStepIp !== firstStepIp + 1 ||
			firstStep?.opcode !== "ITERATOR_STEP" ||
			secondStep?.opcode !== "ITERATOR_STEP" ||
			branch?.opcode !== "JUMP_IF" ||
			branch.cond !== secondStep.doneDst ||
			branch.targetIp !== continuationIp ||
			closeJump?.opcode !== "JUMP" ||
			closeJump.targetIp !== closeIp ||
			close?.opcode !== "ITERATOR_CLOSE" ||
			!close.normal ||
			close.iterator !== cursor.iterator ||
			afterClose?.opcode !== "JUMP" ||
			afterClose.targetIp !== continuationIp
		) {
			continue;
		}
		const common = { cursor } as const;
		nativeArrayPairDestructureActionByIp.set(cursor.initializeIp, {
			...common,
			role: "initialize",
		});
		nativeArrayPairDestructureActionByIp.set(firstStepIp, {
			...common,
			role: "step",
			index: 0,
		});
		nativeArrayPairDestructureActionByIp.set(secondStepIp, {
			...common,
			role: "step",
			index: 1,
		});
		nativeArrayPairDestructureActionByIp.set(closeIp, {
			...common,
			role: "close",
		});
	}
	const jumpTargets = new Set<number>();
	let ownsCaptureEnvironment = coro === null && fn.capturedCount > 0;
	for (const instruction of fn.instructions) {
		switch (instruction.opcode) {
			case "ENV_PUSH":
			case "ENV_COPY":
			case "ENV_POP":
			case "WITH_ENTER":
			case "WITH_EXIT":
				ownsCaptureEnvironment = false;
		}
		if (instruction.opcode === "JUMP" || instruction.opcode === "JUMP_IF") {
			jumpTargets.add(instruction.targetIp);
		}
	}
	// A coroutine resumes at the instruction after each suspend (GENERATOR_START/
	// YIELD/AWAIT), so those need labels for the entry dispatch to jump to.
	if (coro !== null) {
		for (let ip = 0; ip < fn.instructions.length; ip++) {
			const opcode = fn.instructions[ip]!.opcode;
			if (opcode === "GENERATOR_START" || opcode === "YIELD" || opcode === "AWAIT") {
				jumpTargets.add(ip + 1);
			}
		}
	}
	// Exception handlers are reached only via the on-throw goto, so their entry
	// instructions also need labels. The active handler for an instruction is the
	// innermost range covering it (smallest end-start), matching the interpreter's
	// mal_vm_unwind_to_handler.
	for (const handler of fn.handlers) {
		jumpTargets.add(handler.handlerIp);
	}
	const staticDefineStringIndexByIp = new Map<number, number>();
	for (let ip = 1; ip < fn.instructions.length; ip++) {
		const instruction = fn.instructions[ip]!;
		const prior = fn.instructions[ip - 1]!;
		if (
			instruction.opcode === "DEFINE_PROPERTY" &&
			prior.opcode === "CREATE_STRING" &&
			prior.dst === instruction.key &&
			!jumpTargets.has(ip) &&
			!stringConstantIsArrayIndex(stringConstants[prior.stringIndex] ?? [])
		) {
			staticDefineStringIndexByIp.set(ip, prior.stringIndex);
		}
	}
	const handlerTargets = exceptionHandlerTargets(fn.instructions.length, fn.handlers);
	const mathUnaryCalls = new Set<number>();
	const mathBinaryCalls = new Set<number>();
	for (let ip = 0; ip < fn.instructions.length; ip++) {
		const instruction = fn.instructions[ip]!;
		if (instruction.opcode !== "CALL") continue;
		const plan = nativeInstructions[ip];
		const operation =
			plan?.kind === "call" ? plan.guardedBuiltinCall?.operation : undefined;
		if (
			operation !== undefined &&
			instruction.arguments.length === 1 &&
			MATH_UNARY_NATIVE_CALL.has(operation)
		) {
			mathUnaryCalls.add(ip);
		} else if (
			operation !== undefined &&
			instruction.arguments.length === 2 &&
			MATH_BINARY_OPERATIONS.has(operation)
		) {
			mathBinaryCalls.add(ip);
		}
	}
	const nativeStringSplitProjectionActionByIp = new Map<
		number,
		NativeStringSplitProjectionAction
	>();
	for (const action of regionActions) {
		const projection = specializations[action.regionIndex];
		if (projection?.kind !== "string-split-projection") continue;
		const site = stringSplitProjectionSites.get(projection.callIp);
		if (site === undefined) throw new Error("String.split projection action has no site");
		const propertyLoad = regionFallbackPropertyLoad(
			fn,
			projection.propertyPlacement,
			projection.propertyIp,
			site.lockedIdentity,
		);
		const load =
			action.primaryIndex === undefined
				? undefined
				: projection.loads[action.primaryIndex];
		if (
			(action.role !== "property" &&
				action.role !== "call" &&
				action.role !== "element" &&
				action.role !== "length") ||
			((action.role === "element" || action.role === "length") &&
				(load === undefined || load.kind !== action.role))
		) {
			throw new Error("Invalid String.split projection action");
		}
		nativeStringSplitProjectionActionByIp.set(action.ip, {
			site,
			role: action.role,
			...(load === undefined ? {} : { load }),
			...(propertyLoad === undefined ? {} : { propertyLoad }),
		});
	}
	const nativeStringSplitCursorActionByIp = new Map<
		number,
		NativeStringSplitCursorAction
	>();
	for (const action of regionActions) {
		const cursor = specializations[action.regionIndex];
		if (cursor?.kind !== "string-split-cursor") continue;
		const site = stringSplitCursorSites.get(cursor.anchors[0]!);
		if (site === undefined) throw new Error("String.split cursor action has no site");
		const propertyLoad = regionFallbackPropertyLoad(
			fn,
			cursor.propertyPlacement,
			cursor.propertyIp,
			site.lockedIdentity,
		);
		if (
			action.role !== "property" &&
			action.role !== "call" &&
			action.role !== "length" &&
			action.role !== "element" &&
			action.role !== "trimProperty" &&
			action.role !== "trimCall"
		) {
			throw new Error("Invalid String.split cursor action");
		}
		nativeStringSplitCursorActionByIp.set(action.ip, {
			site,
			role: action.role,
			...(propertyLoad === undefined ? {} : { propertyLoad }),
		});
	}
	const nativeRegExpExecProjectionActionByIp = new Map<
		number,
		NativeRegExpExecProjectionAction
	>();
	for (const action of regionActions) {
		const projection = specializations[action.regionIndex];
		if (projection?.kind !== "regexp-exec-projection") continue;
		const site = regexpExecProjectionSites.get(projection.callIp);
		if (site === undefined) throw new Error("RegExp projection action has no site");
		const propertyLoad = regionFallbackPropertyLoad(
			fn,
			projection.propertyPlacement,
			projection.propertyIp,
			projection.lockedFreshLiteral,
		);
		const load =
			action.primaryIndex === undefined
				? undefined
				: projection.loads[action.primaryIndex];
		if (action.primaryIndex !== undefined && load === undefined) {
			throw new Error("Invalid RegExp projection action payload");
		}
		nativeRegExpExecProjectionActionByIp.set(action.ip, {
			site,
			role: action.role as NativeRegExpExecProjectionAction["role"],
			...(load === undefined ? {} : { load }),
			...(propertyLoad === undefined ? {} : { propertyLoad }),
		});
	}
	const nativeRegExpIteratorProjectionActionByIp = new Map<
		number,
		NativeRegExpIteratorProjectionAction
	>();
	for (const action of regionActions) {
		const projection = specializations[action.regionIndex];
		if (projection?.kind !== "regexp-iterator-projection") continue;
		const site = regexpIteratorProjectionSites.get(projection.stepIp);
		if (site === undefined) throw new Error("RegExp iterator action has no site");
		const load =
			action.primaryIndex === undefined
				? undefined
				: projection.loads[action.primaryIndex];
		if (
			(action.role !== "step" && action.role !== "capture" && action.role !== "number") ||
			(action.primaryIndex !== undefined && load === undefined)
		) {
			throw new Error("Invalid RegExp iterator action");
		}
		nativeRegExpIteratorProjectionActionByIp.set(action.ip, {
			site,
			role: action.role,
			...(load === undefined ? {} : { load }),
		});
	}
	const nativeStringSliceNumberFusionActionByIp = new Map<
		number,
		NativeStringSliceNumberFusionAction
	>();
	for (const action of regionActions) {
		const fusion = specializations[action.regionIndex];
		if (fusion?.kind !== "string-slice-number") continue;
		const lockedIdentity = fusion.builtinIdentities === "authority-invariant";
		const propertyLoad = regionFallbackPropertyLoad(
			fn,
			fusion.propertyPlacement,
			fusion.propertyIp,
			lockedIdentity,
		);
		if (
			action.role !== "property" &&
			action.role !== "slice" &&
			action.role !== "number"
		) {
			throw new Error("Invalid String.slice Number action");
		}
		nativeStringSliceNumberFusionActionByIp.set(action.ip, {
			fusion,
			role: action.role,
			lockedIdentity,
			...(propertyLoad === undefined ? {} : { propertyLoad }),
		});
	}
	const lines: Array<string> = [];
	const resources = new Set<NativeBodyResource>();
	const emittedInstructions = new Set<number>();
	const directEntryCalls = new Map<number, Set<number>>();
	const invocationPreamble: Array<string> = [];
	for (const action of nativeStringCharCodeAtChainActionByIp.values()) {
		if (action.role !== "call") continue;
		lines.push(`bool __string_char_code_at_${action.chain.callIp}_captured = false;`);
	}
	for (const action of nativeIteratorCursorActionByIp.values()) {
		if (action.role !== "initialize") continue;
		lines.push(
			`MalIteratorObject *__iter_cursor_${action.cursor.initializeIp} = nullptr;`,
		);
	}
	for (const action of nativeArrayPairDestructureActionByIp.values()) {
		if (action.role !== "initialize") continue;
		const id = action.cursor.initializeIp;
		lines.push(
			`bool __array_pair_${id}_fast = false;`,
			`MalValue __array_pair_${id}_first = MAL_VALUE_UNDEFINED;`,
			`MalValue __array_pair_${id}_second = MAL_VALUE_UNDEFINED;`,
			`bool __array_pair_${id}_first_done = false;`,
			`bool __array_pair_${id}_second_done = false;`,
		);
	}
	for (const action of nativeIteratorEntryPairVirtualizationActionByIp.values()) {
		if (action.role !== "outerStep") continue;
		const id = action.region.outerStepIp;
		lines.push(
			`bool __iter_entry_pair_${id}_fast = false;`,
			`MalValue __iter_entry_pair_${id}_first = MAL_VALUE_UNDEFINED;`,
			`MalValue __iter_entry_pair_${id}_second = MAL_VALUE_UNDEFINED;`,
		);
	}
	for (const site of stringSplitProjectionSites.values()) {
		lines.push(
			`bool __string_split_${site.projection.callIp}_fast = false;`,
			`u32 __string_split_${site.projection.callIp}_length = 0;`,
		);
	}
	for (const site of stringSplitCursorSites.values()) {
		const id = site.callIp;
		lines.push(
			`bool __string_split_cursor_${id}_active = false;`,
			`bool __string_split_cursor_${id}_has = false;`,
			`bool __string_split_cursor_${id}_trim_fast = false;`,
			`MalStringSplitCursor __string_split_cursor_${id}_state = { 0 };`,
			`usize __string_split_cursor_${id}_start = 0;`,
			`usize __string_split_cursor_${id}_end = 0;`,
			...(site.semanticEpochStable || site.trimCalleeSlot === undefined
				? []
				: [`u64 ${site.epochName} = 0;`]),
		);
	}
	for (const site of regexpExecProjectionSites.values()) {
		lines.push(
			`bool __regexp_exec_${site.projection.callIp}_fast = false;`,
			`bool __regexp_exec_${site.projection.callIp}_projected = false;`,
			`i32 __regexp_exec_${site.projection.callIp}_starts[${site.loads.length}];`,
			`i32 __regexp_exec_${site.projection.callIp}_ends[${site.loads.length}];`,
		);
		for (const load of site.loads) {
			if (load.consumer?.kind === "charCodeAtZero") {
				lines.push(
					`bool __regexp_exec_${site.projection.callIp}_char_${load.consumer.callIp}_fast = false;`,
				);
			} else if (load.consumer?.kind === "asciiCaseLength") {
				lines.push(
					`bool __regexp_exec_${site.projection.callIp}_case_${load.consumer.upperCallIp}_fast = false;`,
					`u32 __regexp_exec_${site.projection.callIp}_case_${load.consumer.upperCallIp}_length = 0;`,
				);
			}
		}
	}
	for (const site of regexpIteratorProjectionSites.values()) {
		lines.push(
			`bool __regexp_iter_${site.projection.stepIp}_projected = false;`,
			`i32 __regexp_iter_${site.projection.stepIp}_starts[${site.loads.length}];`,
			`i32 __regexp_iter_${site.projection.stepIp}_ends[${site.loads.length}];`,
		);
	}
	for (const action of nativeStringSliceNumberFusionActionByIp.values()) {
		if (action.role !== "slice") continue;
		const { fusion } = action;
		lines.push(
			`bool __string_slice_number_${fusion.sliceCallIp}_fast = false;`,
			`f64 __string_slice_number_${fusion.sliceCallIp}_value = 0;`,
		);
	}
	for (const action of indexedLengthLoopActionByIp.values()) {
		if (action.role !== "load") continue;
		lines.push(
			`u8 __indexed_length_${action.loadIp}_kind = 0;`,
			`MalArrayObject *__indexed_length_${action.loadIp}_array = nullptr;`,
			`MalTypedArrayObject *__indexed_length_${action.loadIp}_typed_array = nullptr;`,
			`u32 __indexed_length_${action.loadIp}_value = 0;`,
			`f64 __indexed_length_${action.loadIp}_induction = 0;`,
		);
	}
	for (const action of nativeArrayPresenceProjectionActionByIp.values()) {
		if (action.role !== "membership") continue;
		lines.push(
			`i32 __array_presence_${action.membershipIp}_state = -1;`,
			`MalValue __array_presence_${action.membershipIp}_value = MAL_VALUE_UNDEFINED;`,
		);
	}
	if (
		[...stringSplitCursorSites.values()].some((site) => !site.lockedIdentity) ||
		[...nativeStringCharCodeAtChainActionByIp.values()].some(
			(action) =>
				action.role === "call" && action.chain.methodIdentity === "runtime-guarded",
		) ||
		[...regexpExecProjectionSites.values()].some((site) =>
			site.loads.some(
				(load) =>
					(load.consumer?.kind === "charCodeAtZero" ||
						load.consumer?.kind === "asciiCaseLength") &&
					load.consumer.methodIdentity === "runtime-guarded",
			),
		)
	) {
		const watchedMethodsAdmission =
			watchedMethodsGuard === undefined
				? "false"
				: semanticDependencyAdmissionGuard(watchedMethodsGuard);
		const watchedMethodsEpoch =
			watchedMethodsAdmission === "true"
				? "vm->semantic_epochs.watched_methods"
				: watchedMethodsAdmission === "false"
					? "0"
					: `${watchedMethodsAdmission} ? vm->semantic_epochs.watched_methods : 0`;
		(coro === null ? lines : invocationPreamble).push(
			`u64 __watched_methods_epoch = ${watchedMethodsEpoch};`,
		);
	}
	// Pair-fusion temporaries live for the whole C function so intervening property
	// loads retain their original position and control-flow labels never jump over a
	// declaration. Only boxed first results benefit from avoiding the box/unbox.
	for (let ip = 0; ip < fn.instructions.length; ip++) {
		const instruction = fn.instructions[ip]!;
		const fusion = numericFusionActionByIp.get(ip);
		if (
			instruction.opcode === "BINARY" &&
			fusion?.role === "start" &&
			reps[instruction.dst] !== "number"
		) {
			const id = fusion.id;
			lines.push(`bool __nf_${id}_ok = false;`);
			lines.push(`f64 __nf_${id}_value = 0.0;`);
		}
	}
	// Publish source positions only before operations that can synchronously capture
	// this frame. Pure arithmetic/control-flow transitions need no native-frame write.
	const fieldAllocations = new Map<number, NativeFieldCall>();
	const fieldCallSites = new Map<number, NativeFieldCall>();
	for (const site of fieldCalls ?? []) {
		fieldAllocations.set(site.allocationIp, site);
		fieldCallSites.set(site.callIp, site);
		for (let field = 0; field < site.allocation.count; field++) {
			if (site.boxedSlots[field] === undefined)
				lines.push(`f64 __field_${site.allocationIp}_${field} = 0;`);
		}
	}

	const fieldLoads = new Map(
		directFields?.loads.map((load) => [load.instructionIp, load.field]),
	);
	const staticPropertyProjectionActionByIp = new Map<
		number,
		NativeStaticPropertyProjectionAction
	>();
	const staticPropertyProjectionConflicts = (ip: number): boolean =>
		nativeInstructions[ip] !== undefined ||
		fieldLoads.has(ip) ||
		stackObjectAccesses.has(ip) ||
		stackObjectInheritedAccesses.has(ip) ||
		indexedLengthLoopActionByIp.has(ip) ||
		nativeStringSplitProjectionActionByIp.has(ip) ||
		nativeStringSplitCursorActionByIp.has(ip) ||
		nativeRegExpExecProjectionActionByIp.has(ip) ||
		nativeRegExpIteratorProjectionActionByIp.has(ip) ||
		nativeStringSliceNumberFusionActionByIp.has(ip) ||
		nativeStringCharCodeAtChainActionByIp.has(ip) ||
		nativeBuiltinCollectionCallChainActionByIp.has(ip);
	const indexedLoopElements = [...indexedLengthLoopActionByIp.entries()].flatMap(
		([ip, action]) => {
			const instruction = fn.instructions[ip];
			return action.role === "element" &&
				action.element?.kind === "load" &&
				action.element.arrayIndexIsUint32 &&
				instruction?.opcode === "LOAD_PROPERTY"
				? [
						{
							lengthLoadIp: action.loadIp,
							elementLoadIp: ip,
							object: instruction.object,
							key: instruction.key,
							result: instruction.dst,
						},
					]
				: [];
		},
	);
	const nativeFastPaths = lowerNativeFastPaths(
		fn,
		reps,
		jumpTargets,
		staticPropertyProjectionConflicts,
		indexedLoopElements,
	);
	const staticPropertyNumericActionByIp = nativeFastPaths.propertyProjectionActions;
	const pairedArrayLoopActionByIp = nativeFastPaths.pairedArrayLoopActions;
	const pairedArrayLoopByLengthLoad = new Map(
		nativeFastPaths.pairedArrayLoops.map((plan) => [plan.lengthLoadIp, plan]),
	);
	const constructorInitializationActionByIp =
		nativeFastPaths.constructorInitializationActions;
	if (nativeFastPaths.constructorInitialization !== undefined) {
		const id = nativeFastPaths.constructorInitialization.id;
		lines.push(`bool __constructor_initialization_${id}_fast = false;`);
		lines.push(`MalObject *__constructor_initialization_${id}_object = nullptr;`);
	}
	for (const projection of nativeFastPaths.propertyProjections) {
		lines.push(`bool __property_projection_${projection.id}_fast = false;`);
		for (const [index] of projection.loads.entries())
			lines.push(`f64 __property_projection_${projection.id}_value_${index} = 0.0;`);
		for (const [index] of projection.steps.entries())
			lines.push(`f64 __property_projection_${projection.id}_step_${index} = 0.0;`);
	}
	for (const paired of nativeFastPaths.pairedArrayLoops) {
		lines.push(
			`bool __paired_array_${paired.id}_fast = false;`,
			`MalArrayObject *__paired_array_${paired.id}_secondary = nullptr;`,
		);
	}
	for (let ip = 0; ip + 1 < fn.instructions.length; ip++) {
		const first = fn.instructions[ip]!;
		const second = fn.instructions[ip + 1]!;
		if (
			staticPropertyNumericActionByIp.has(ip) ||
			staticPropertyNumericActionByIp.has(ip + 1) ||
			first.opcode !== "LOAD_PROPERTY_STATIC" ||
			second.opcode !== "LOAD_PROPERTY_STATIC" ||
			first.object !== second.object ||
			first.dst === first.object ||
			reps[first.dst] !== "boxed" ||
			reps[second.dst] !== "boxed" ||
			jumpTargets.has(ip + 1) ||
			staticPropertyProjectionConflicts(ip) ||
			staticPropertyProjectionConflicts(ip + 1)
		) {
			continue;
		}
		const projection: NativeStaticPropertyProjection = {
			firstIp: ip,
			first,
			secondIp: ip + 1,
			second,
		};
		staticPropertyProjectionActionByIp.set(ip, { projection, role: "first" });
		staticPropertyProjectionActionByIp.set(ip + 1, { projection, role: "second" });
		lines.push(`bool __property_projection_${ip}_fast = false;`);
		lines.push(
			`MalValue __property_projection_${ip}_first = MAL_VALUE_UNDEFINED;`,
			`MalValue __property_projection_${ip}_second = MAL_VALUE_UNDEFINED;`,
		);
		ip++;
	}
	const switches = new Map(
		fn.profileSiteIds === undefined
			? literalSwitches?.map((site) => [site.instructionIp, site])
			: [],
	);
	let lastPublishedPos = -1;
	let lastPublishedSite = -1;
	let lastPublishedInactiveRootMask: bigint | undefined;
	for (let ip = 0; ip < fn.instructions.length; ip++) {
		if (jumpTargets.has(ip)) {
			lines.push(`L${ip}:;`);
			// Control can arrive with different published frame metadata.
			lastPublishedPos = -1;
			lastPublishedSite = -1;
			lastPublishedInactiveRootMask = undefined;
		}
		const literalSwitch = switches.get(ip);
		if (literalSwitch !== undefined) {
			const branch = (target: number, branchIp: number) => {
				const mask = inactiveRootMasks.get(branchIp);
				if (target > branchIp) return `goto L${target};`;
				if (gcSafepointKinds.get(branchIp) !== "loop-backedge")
					throw new Error("Native switch backedge has no root plan");
				return `if (mal_gc_poll) { ${mask === undefined ? "" : `${cInactiveRootMaskPublication(mask)}; `}mal_gc_safepoint(vm); } goto L${target};`;
			};
			if (literalSwitch.kind === "string") {
				const emitted = emitStringSwitch(
					literalSwitch,
					stringConstants,
					suffix,
					reps[literalSwitch.selector]!,
					relocation,
					branch,
				);
				if (emitted !== undefined) {
					lines.push(...emitted.lines);
					profileDecisions.push({
						instructionIndex: ip,
						operation: "switch",
						code: "native-string-switch",
						outcome: "applied",
						details: {
							strategy: emitted.strategy,
							cases: literalSwitch.cases.length,
						},
					});
					ip = literalSwitch.endIp;
					continue;
				}
			} else {
				const fallback = branch(literalSwitch.defaultIp, literalSwitch.endIp);
				const selector = literalSwitch.selector;
				const representation = reps[selector];
				if (representation === "boolean" || representation === "string")
					lines.push(fallback);
				else {
					if (representation === "boxed")
						lines.push(`if (!mal_ops_is_number(r${selector})) { ${fallback} }`);
					const value = `__switch_${ip}`;
					lines.push(
						`f64 ${value} = ${representation === "boxed" ? `mal_ops_number_as_f64(r${selector})` : `r${selector}`};`,
					);
					if (representation !== "int32")
						lines.push(
							`if (!(${value} >= -2147483648.0 && ${value} <= 2147483647.0 && ${value} == trunc(${value}))) { ${fallback} }`,
						);
					lines.push(`switch ((i32) ${value}) {`);
					const seen = new Set<number>();
					for (const [index, label] of literalSwitch.cases.entries()) {
						if (seen.has(label.value)) continue;
						seen.add(label.value);
						lines.push(
							`case ${label.value}: ${branch(label.targetIp, ip + index * 3 + 2)}`,
						);
					}
					lines.push(`default: ${fallback}`, "}");
				}
				ip = literalSwitch.endIp;
				continue;
			}
		}
		const safepointKind = gcSafepointKinds.get(ip);
		const inactiveRootMask = inactiveRootMasks.get(ip);
		const loopBackedgeInactiveRootMask =
			safepointKind === "loop-backedge" &&
			inactiveRootMask !== lastPublishedInactiveRootMask
				? inactiveRootMask
				: undefined;
		const mathCallInactiveRootMask =
			safepointKind === "operation" &&
			(mathUnaryCalls.has(ip) || mathBinaryCalls.has(ip)) &&
			inactiveRootMask !== lastPublishedInactiveRootMask
				? inactiveRootMask
				: undefined;
		const tdzInactiveRootMask =
			safepointKind === "operation" &&
			fn.instructions[ip]!.opcode === "THROW_IF_TDZ" &&
			inactiveRootMask !== lastPublishedInactiveRootMask
				? inactiveRootMask
				: undefined;
		const knownOwnSlotLoadInactiveRootMask =
			safepointKind === "operation" &&
			fn.instructions[ip]!.opcode === "LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT" &&
			inactiveRootMask !== lastPublishedInactiveRootMask
				? inactiveRootMask
				: undefined;
		const staticPropertyLoadInactiveRootMask =
			safepointKind === "operation" &&
			fn.instructions[ip]!.opcode === "LOAD_PROPERTY_STATIC" &&
			nativeInstructions[ip] === undefined &&
			stackObjectAccesses.get(ip) === undefined &&
			stackObjectInheritedAccesses.get(ip) === undefined &&
			nativeStringSplitProjectionActionByIp.get(ip) === undefined &&
			nativeStringSplitCursorActionByIp.get(ip) === undefined &&
			nativeRegExpExecProjectionActionByIp.get(ip) === undefined &&
			nativeRegExpIteratorProjectionActionByIp.get(ip) === undefined &&
			nativeStringSliceNumberFusionActionByIp.get(ip) === undefined &&
			nativeStringCharCodeAtChainActionByIp.get(ip) === undefined &&
			nativeBuiltinCollectionCallChainActionByIp.get(ip) === undefined &&
			inactiveRootMask !== lastPublishedInactiveRootMask
				? inactiveRootMask
				: undefined;
		if (
			inactiveRootMask !== undefined &&
			loopBackedgeInactiveRootMask === undefined &&
			mathCallInactiveRootMask === undefined &&
			tdzInactiveRootMask === undefined &&
			knownOwnSlotLoadInactiveRootMask === undefined &&
			staticPropertyLoadInactiveRootMask === undefined &&
			inactiveRootMask !== lastPublishedInactiveRootMask
		) {
			lines.push(`    ${cInactiveRootMaskPublication(inactiveRootMask)};`);
		}
		if (
			inactiveRootMask !== undefined &&
			loopBackedgeInactiveRootMask === undefined &&
			mathCallInactiveRootMask === undefined &&
			tdzInactiveRootMask === undefined &&
			knownOwnSlotLoadInactiveRootMask === undefined &&
			staticPropertyLoadInactiveRootMask === undefined
		) {
			lastPublishedInactiveRootMask = inactiveRootMask;
		}
		const instructionProfile: NativeInstructionProfile | undefined =
			(fn.profileSiteIds?.[ip] ?? -1) >= 0 ? {} : undefined;
		const arrayPresenceAction = nativeArrayPresenceProjectionActionByIp.get(ip);
		emittedInstructions.add(ip);
		const emitted = emitInstruction(
			fn.instructions[ip]!,
			ip,
			suffix,
			reps,
			fn.strict,
			handlerTargets[ip],
			gcUnlink,
			thisSlot,
			coro,
			{
				nativePlan: nativeInstructions[ip],
				stringConstants,
				staticDefineStringIndexByIp,
				resources,
				directEntryCalls,
				profileSiteId: fn.profileSiteIds?.[ip],
				profile: instructionProfile,
				gcSafepoint: safepointKind !== undefined,
				loopBackedgeInactiveRootMask,
				mathCallInactiveRootMask,
				tdzInactiveRootMask,
				knownOwnSlotLoadInactiveRootMask,
				staticPropertyLoadInactiveRootMask,
				stackObjectSite: stackObjectSites.get(ip),
				stackObjectAccess: stackObjectAccesses.get(ip),
				stackObjectMaterialization: stackObjectMaterializations.get(ip),
				stackObjectInheritedAccess: stackObjectInheritedAccesses.get(ip),
				directCompiledTargets,
				directCompiledEntries,
				ownedCaptureFunctionIndex: ownsCaptureEnvironment ? functionIndex : undefined,
				strictCompiledTargets,
				directResultRepresentation,
				directArgumentRepresentations,
				constantBoolean: directConstantBooleans.get(ip),
				fieldLoad: fieldLoads.get(ip),
				fieldAllocation: fieldAllocations.get(ip),
				fieldCall: fieldCallSites.get(ip),
				mathUnaryCall: mathUnaryCalls.has(ip),
				mathBinaryCall: mathBinaryCalls.has(ip),
				mappedArguments: fn.mappedArguments,
				mappedArgumentSlots: fn.mappedArgumentSlots,
				hasPrototype: fn.hasPrototype,
				indexedLengthLoopAction: indexedLengthLoopActionByIp.get(ip),
				nativeArrayPresenceProjectionAction: arrayPresenceAction,
				pairedArrayLoopAction: pairedArrayLoopActionByIp.get(ip),
				pairedArrayLoopPresence:
					arrayPresenceAction === undefined
						? undefined
						: pairedArrayLoopByLengthLoad.get(arrayPresenceAction.indexed.loadIp),
				nativeStringSplitProjectionAction: nativeStringSplitProjectionActionByIp.get(ip),
				nativeStringSplitCursorAction: nativeStringSplitCursorActionByIp.get(ip),
				nativeRegExpExecProjectionAction: nativeRegExpExecProjectionActionByIp.get(ip),
				nativeRegExpIteratorProjectionAction:
					nativeRegExpIteratorProjectionActionByIp.get(ip),
				nativeStringSliceNumberFusionAction:
					nativeStringSliceNumberFusionActionByIp.get(ip),
				nativeStringCharCodeAtChainAction: nativeStringCharCodeAtChainActionByIp.get(ip),
				nativeBuiltinCollectionCallChainAction:
					nativeBuiltinCollectionCallChainActionByIp.get(ip),
				nativeIteratorCursorAction: nativeIteratorCursorActionByIp.get(ip),
				nativeArrayPairDestructureAction: nativeArrayPairDestructureActionByIp.get(ip),
				nativeIteratorResultVirtualizationAction:
					nativeIteratorResultVirtualizationActionByIp.get(ip),
				nativeIteratorEntryPairVirtualizationAction:
					nativeIteratorEntryPairVirtualizationActionByIp.get(ip),
				numericFusionAction: numericFusionActionByIp.get(ip),
				staticPropertyProjectionAction: staticPropertyProjectionActionByIp.get(ip),
				staticPropertyNumericAction: staticPropertyNumericActionByIp.get(ip),
				constructorInitializationAction: constructorInitializationActionByIp.get(ip),
				relocation,
			},
		);
		if (emitted === null) {
			return null;
		}
		if (
			mathCallInactiveRootMask !== undefined ||
			tdzInactiveRootMask !== undefined ||
			knownOwnSlotLoadInactiveRootMask !== undefined ||
			staticPropertyLoadInactiveRootMask !== undefined
		) {
			// Conditional paths can preserve the old mask or publish the instruction's mask.
			lastPublishedInactiveRootMask = undefined;
		}
		if (debug && nativeInstructionMayCaptureStack(fn.instructions[ip]!, reps)) {
			const pos = fn.positions[ip] ?? -1;
			if (pos !== -1 && pos !== lastPublishedPos) {
				lines.push(
					`    vm->native_frames[vm->native_frame_count - 1].pos_id = ${relocation.sourcePosition(pos)};`,
				);
				lastPublishedPos = pos;
			}
		}
		const profileSiteId = fn.profileSiteIds?.[ip] ?? -1;
		if (
			debug &&
			profileSiteId >= 0 &&
			nativeInstructionMayCaptureStack(fn.instructions[ip]!, reps) &&
			profileSiteId !== lastPublishedSite
		) {
			lines.push(
				`    vm->native_frames[vm->native_frame_count - 1].site_id = ${profileSiteId};`,
			);
			lastPublishedSite = profileSiteId;
		}
		if (profileSiteId >= 0) {
			lines.push(
				`    MAL_PROFILE_CURRENT_SITE(vm, ${profileSiteId});`,
				`    MAL_PROFILE_SITE_EVENT(vm, ${profileSiteId}, MAL_PROFILE_SITE_EXECUTION, 1);`,
			);
			const operationSite = profileOperationInstruction(fn.instructions[ip]!);
			const boxingSite = profileBoxesNativeValue(emitted);
			if (operationSite || boxingSite) {
				profileDecisions.push(
					...profileDecisionsForInstruction(
						fn.instructions[ip]!,
						ip,
						emitted,
						boxingSite,
						instructionProfile?.decision,
					),
				);
			}
		}
		for (const line of emitted) {
			lines.push(`    ${line}`);
		}
	}

	return {
		lines,
		resources,
		invocationPreamble,
		emittedInstructions,
		directEntryCalls,
	};
}

function profileOperationInstruction(instruction: BytecodeInstruction): boolean {
	return profileDecisionOperation(instruction) !== "execute";
}

function profileDecisionOperation(instruction: BytecodeInstruction): string {
	return profileOperationForInstruction(instruction);
}

/** Classify the exact emitted body, after every native specialization pass. */
function profileDecisionsForInstruction(
	instruction: BytecodeInstruction,
	instructionIndex: number,
	emitted: ReadonlyArray<string>,
	boxingSite: boolean,
	explicitDecision: BackendProfileDecision | undefined,
): Array<BackendProfileDecision> {
	const operation = profileDecisionOperation(instruction);
	const source = emitted.join("\n");
	const decision = (
		code: string,
		outcome: BackendProfileDecision["outcome"],
		reasonCode?: string,
	): BackendProfileDecision => ({
		instructionIndex,
		operation,
		code,
		outcome,
		...(reasonCode === undefined ? {} : { reasonCode }),
		details: {
			opcode: instruction.opcode,
			...(instruction.opcode === "BINARY" || instruction.opcode === "UNARY"
				? { operator: instruction.operator }
				: {}),
		},
	});
	const decisions: Array<BackendProfileDecision> = [];

	if (operation === "call" || operation === "construct") {
		if (explicitDecision !== undefined) {
			decisions.push(explicitDecision);
		} else if (
			/__string_split_|__regexp_exec_|mal_builtin_string_slice_to_number/.test(source)
		) {
			decisions.push(
				decision(`${operation}.projected`, "guarded", "guarded-semantic-fallback"),
			);
		} else if (/mal_builtin_.*_direct\(/.test(source)) {
			decisions.push(
				decision(
					`${operation}.builtin-direct`,
					"retained",
					"runtime-helper-owned-dispatch",
				),
			);
		} else if (source.includes("mal_vm_call_direct(")) {
			decisions.push(
				decision("call.direct-compiled", "guarded", "callee-identity-guard"),
			);
		} else if (source.includes("mal_vm_call_cached(")) {
			decisions.push(
				decision(
					`${operation}.inline-cache`,
					"retained",
					"runtime-target-guard-required",
				),
			);
		} else {
			decisions.push(
				decision(`${operation}.runtime`, "retained", "unsupported-native-call"),
			);
		}
	} else if (operation === "property") {
		if (
			source.includes("mal_vm_object_slot_store(mal_value_to_object(") ||
			/\bmal_value_to_object\([^)]*\)->slots\[\d+\]/.test(source)
		) {
			decisions.push(decision("property.exact-own-slot", "applied"));
		} else if (source.includes("mal_vm_try_load_known_own_slots(")) {
			decisions.push(
				decision("property.known-own-slot", "guarded", "exact-shape-fallback"),
			);
		} else if (/__stack_object_|__regexp_exec_|__string_split_/.test(source)) {
			decisions.push(
				decision("property.projected", "guarded", "guarded-semantic-fallback"),
			);
		} else if (source.includes("mal_vm_local_watched_")) {
			decisions.push(decision("property.watched", "guarded", "invalidatable-epoch"));
		} else if (/mal_vm_array_fast_(load_index|store_index)\(/.test(source)) {
			decisions.push(
				decision(
					"property.array-inline-cache",
					"guarded",
					"runtime-shape-guard-required",
				),
			);
		} else if (
			/mal_vm_op_(?:load_property_ic(?:_static_miss)?|store_property_ic)\(/.test(source)
		) {
			decisions.push(
				decision(
					instruction.opcode.endsWith("_STATIC")
						? "property.static-inline-cache"
						: "property.dynamic-inline-cache",
					"retained",
					"runtime-shape-guard-required",
				),
			);
		} else {
			decisions.push(decision("property.native", "applied"));
		}
	} else if (operation === "allocation") {
		if (source.includes("__stack_object_")) {
			decisions.push(decision("allocation.stack", "elided"));
		} else {
			decisions.push(decision("allocation.heap", "retained", "heap-identity-retained"));
		}
	} else if (operation === "binary" || operation === "unary") {
		if (source.includes("mal_ops_is_number(")) {
			decisions.push(decision(`${operation}.native`, "guarded", "numeric-type-guard"));
		} else if (/mal_vm_(binary|unary)_op\(/.test(source)) {
			decisions.push(
				decision(`${operation}.runtime`, "retained", "representation-not-proven-native"),
			);
		} else {
			decisions.push(decision(`${operation}.native`, "applied"));
		}
	}

	if (boxingSite) {
		decisions.push({
			instructionIndex,
			operation: "boxing",
			code: "boxing.value-materialization",
			outcome: "retained",
			reasonCode: "boxed-representation-required",
			details: { opcode: instruction.opcode },
		});
	}
	return decisions;
}

function profileBoxesNativeValue(lines: ReadonlyArray<string>): boolean {
	return lines.some(
		(line) =>
			line.includes("mal_ops_number_value(") || line.includes("mal_value_new_boolean("),
	);
}

interface NativeInstructionProfile {
	decision?: BackendProfileDecision;
}

function nativeCallDecision(
	profile: NativeInstructionProfile | undefined,
	instructionIndex: number,
	code: string,
	outcome: BackendProfileDecision["outcome"],
	reasonCode?: string,
): void {
	if (profile === undefined) return;
	profile.decision = {
		instructionIndex,
		operation: "call",
		code,
		outcome,
		...(reasonCode === undefined ? {} : { reasonCode }),
		details: { opcode: "CALL" },
	};
}

type NativeProfileCallKind =
	| "boxing"
	| "regexp"
	| "string"
	| "call"
	| "construct"
	| "property"
	| "allocation"
	| "binary"
	| "unary";

function nativeProfileCall(
	kind: NativeProfileCallKind,
	expression: string,
	siteId: number,
	operation: string,
): string {
	if (siteId < 0) return expression;
	if (kind === "boxing") return `MAL_PROFILE_SITE_BOX(vm, ${siteId}, ${expression})`;
	if (kind === "regexp" || kind === "string") {
		const event =
			kind === "regexp"
				? "MAL_PROFILE_SITE_RUNTIME_REGEXP"
				: "MAL_PROFILE_SITE_RUNTIME_STRING";
		return `MAL_PROFILE_RUNTIME_VALUE(vm, ${siteId}, ${event}, ${expression})`;
	}
	return kind === operation
		? `MAL_PROFILE_FALLBACK_VALUE(vm, ${siteId}, ${expression})`
		: expression;
}

/**
 * Lower a single instruction to C, or null if it isn't handled yet. Reads of a
 * `number` register use the raw double; reads where a boxed value is required
 * box it through mal_ops_number_value. Adding an opcode here (and its unboxed
 * forms) is the main way this backend grows.
 */
interface NativeFieldCall {
	readonly allocationIp: number;
	readonly callIp: number;
	readonly allocation: Extract<BytecodeInstruction, { opcode: "CREATE_OBJECT_SHAPED" }>;
	readonly boxedSlots: ReadonlyArray<number | undefined>;
	readonly entries: ReadonlyArray<{
		readonly functionIndex: number;
		readonly entryId: number;
	}>;
}

interface NativeStaticPropertyProjection {
	readonly firstIp: number;
	readonly first: Extract<BytecodeInstruction, { opcode: "LOAD_PROPERTY_STATIC" }>;
	readonly secondIp: number;
	readonly second: Extract<BytecodeInstruction, { opcode: "LOAD_PROPERTY_STATIC" }>;
}

interface NativeStaticPropertyProjectionAction {
	readonly projection: NativeStaticPropertyProjection;
	readonly role: "first" | "second";
}

interface NativeInstructionContext {
	readonly ownedCaptureFunctionIndex?: number;
	readonly resources: Set<NativeBodyResource>;
	readonly directEntryCalls: Map<number, Set<number>>;
	readonly profileSiteId?: number;
	readonly profile?: NativeInstructionProfile;
	readonly nativePlan?: NativeInstructionPlan;
	readonly gcSafepoint: boolean;
	readonly loopBackedgeInactiveRootMask?: bigint;
	readonly mathCallInactiveRootMask?: bigint;
	readonly tdzInactiveRootMask?: bigint;
	readonly knownOwnSlotLoadInactiveRootMask?: bigint;
	readonly staticPropertyLoadInactiveRootMask?: bigint;
	readonly stackObjectSite?: StackObjectSite;
	readonly stackObjectAccess?: { site: StackObjectSite; slot: number };
	readonly stackObjectMaterialization?: StackObjectSite;
	readonly stackObjectInheritedAccess?: StackObjectSite;
	readonly strictCompiledTargets: ReadonlySet<number>;
	readonly directCompiledTargets: ReadonlySet<number>;
	readonly directCompiledEntries: DirectCompiledEntries;
	readonly directResultRepresentation?: VmRegisterRepresentation;
	readonly directArgumentRepresentations?: ReadonlyArray<VmRegisterRepresentation>;
	readonly constantBoolean?: boolean;
	readonly fieldLoad?: number;
	readonly fieldAllocation?: NativeFieldCall;
	readonly fieldCall?: NativeFieldCall;
	readonly fieldEntryCall?: NativeFieldCall;
	readonly mathUnaryCall: boolean;
	readonly mathBinaryCall: boolean;
	readonly mappedArguments: boolean;
	readonly mappedArgumentSlots: ReadonlyArray<number>;
	readonly hasPrototype: boolean;
	readonly indexedLengthLoopAction?: IndexedLengthLoopAction;
	readonly nativeArrayPresenceProjectionAction?: NativeArrayPresenceProjectionAction;
	readonly pairedArrayLoopAction?: NativePairedArrayLoopAction;
	readonly pairedArrayLoopPresence?: NativePairedArrayLoopPlan;
	readonly nativeStringSplitProjectionAction?: NativeStringSplitProjectionAction;
	readonly nativeStringSplitCursorAction?: NativeStringSplitCursorAction;
	readonly nativeRegExpExecProjectionAction?: NativeRegExpExecProjectionAction;
	readonly nativeRegExpIteratorProjectionAction?: NativeRegExpIteratorProjectionAction;
	readonly nativeStringSliceNumberFusionAction?: NativeStringSliceNumberFusionAction;
	readonly nativeStringCharCodeAtChainAction?: NativeStringCharCodeAtChainAction;
	readonly nativeBuiltinCollectionCallChainAction?: NativeBuiltinCollectionCallChainAction;
	readonly nativeIteratorCursorAction?: NativeIteratorCursorAction;
	readonly nativeArrayPairDestructureAction?: NativeArrayPairDestructureAction;
	readonly nativeIteratorResultVirtualizationAction?: NativeIteratorResultVirtualizationAction;
	readonly nativeIteratorEntryPairVirtualizationAction?: NativeIteratorEntryPairVirtualizationAction;
	readonly numericFusionAction?: NativeNumericFusionAction;
	readonly staticPropertyProjectionAction?: NativeStaticPropertyProjectionAction;
	readonly staticPropertyNumericAction?: NativePropertyProjectionAction;
	readonly constructorInitializationAction?: NativeConstructorInitializationAction;
	readonly relocation: NativeRelocationExpressions;
	readonly stringConstants: ReadonlyArray<ReadonlyArray<number>>;
	readonly staticDefineStringIndexByIp: ReadonlyMap<number, number>;
}

type NativeTypedArrayElementKind = Extract<
	NativeInstructionPlan,
	{ readonly elementKind: unknown }
>["elementKind"];

function nativeTypedArrayKind(kind: NativeTypedArrayElementKind): string {
	switch (kind) {
		case "Int8Array":
			return "MAL_TA_INT8";
		case "Uint8Array":
			return "MAL_TA_UINT8";
		case "Uint8ClampedArray":
			return "MAL_TA_UINT8_CLAMPED";
		case "Int16Array":
			return "MAL_TA_INT16";
		case "Uint16Array":
			return "MAL_TA_UINT16";
		case "Int32Array":
			return "MAL_TA_INT32";
		case "Uint32Array":
			return "MAL_TA_UINT32";
		case "Float32Array":
			return "MAL_TA_FLOAT32";
		case "Float64Array":
			return "MAL_TA_FLOAT64";
	}
}

function nativeTypedArrayElementSize(kind: NativeTypedArrayElementKind): number {
	switch (kind) {
		case "Int8Array":
		case "Uint8Array":
		case "Uint8ClampedArray":
			return 1;
		case "Int16Array":
		case "Uint16Array":
			return 2;
		case "Int32Array":
		case "Uint32Array":
		case "Float32Array":
			return 4;
		case "Float64Array":
			return 8;
	}
}

function emitInstruction(
	instruction: BytecodeInstruction,
	ip: number,
	suffix: string,
	reps: Array<RegisterRep>,
	strict: boolean,
	handlerIp: number | undefined,
	gcUnlink: string,
	thisSlot: number,
	coro: CoroutineContext | null,
	context: NativeInstructionContext,
): Array<string> | null {
	const {
		nativePlan,
		resources,
		stackObjectSite,
		stackObjectAccess,
		stackObjectMaterialization,
		stackObjectInheritedAccess,
		directCompiledTargets,
		directCompiledEntries,
		directResultRepresentation,
		mathUnaryCall,
		mathBinaryCall,
		mappedArguments,
		mappedArgumentSlots,
		hasPrototype,
		indexedLengthLoopAction,
		nativeArrayPresenceProjectionAction,
		pairedArrayLoopAction,
		pairedArrayLoopPresence,
		nativeStringSplitProjectionAction,
		nativeStringSplitCursorAction,
		nativeRegExpExecProjectionAction,
		nativeRegExpIteratorProjectionAction,
		nativeStringSliceNumberFusionAction,
		nativeStringCharCodeAtChainAction,
		nativeBuiltinCollectionCallChainAction,
		nativeIteratorCursorAction,
		nativeArrayPairDestructureAction,
		nativeIteratorResultVirtualizationAction,
		nativeIteratorEntryPairVirtualizationAction,
		numericFusionAction,
		staticPropertyProjectionAction,
		staticPropertyNumericAction,
		constructorInitializationAction,
		relocation,
	} = context;
	const profileSiteId = context.profileSiteId ?? -1;
	const profileOperation =
		profileSiteId < 0 ? undefined : profileDecisionOperation(instruction);
	const profileCall = (kind: NativeProfileCallKind, expression: string): string =>
		profileOperation === undefined
			? expression
			: nativeProfileCall(kind, expression, profileSiteId, profileOperation);
	const genericContext: NativeInstructionContext = {
		stringConstants: context.stringConstants,
		staticDefineStringIndexByIp: context.staticDefineStringIndexByIp,
		directEntryCalls: context.directEntryCalls,
		profileSiteId: context.profileSiteId,
		profile: context.profile,
		nativePlan,
		resources,
		gcSafepoint: context.gcSafepoint,
		loopBackedgeInactiveRootMask: context.loopBackedgeInactiveRootMask,
		mathCallInactiveRootMask: context.mathCallInactiveRootMask,
		tdzInactiveRootMask: context.tdzInactiveRootMask,
		knownOwnSlotLoadInactiveRootMask: context.knownOwnSlotLoadInactiveRootMask,
		staticPropertyLoadInactiveRootMask: context.staticPropertyLoadInactiveRootMask,
		ownedCaptureFunctionIndex: context.ownedCaptureFunctionIndex,
		strictCompiledTargets: context.strictCompiledTargets,
		directCompiledTargets,
		directCompiledEntries,
		directResultRepresentation,
		directArgumentRepresentations: context.directArgumentRepresentations,
		constantBoolean: context.constantBoolean,
		fieldEntryCall: context.fieldEntryCall,
		mathUnaryCall,
		mathBinaryCall,
		mappedArguments,
		mappedArgumentSlots,
		hasPrototype,
		relocation,
	};
	const emitGenericInstruction = (): Array<string> | null =>
		emitInstruction(
			instruction,
			ip,
			suffix,
			reps,
			strict,
			handlerIp,
			gcUnlink,
			thisSlot,
			coro,
			genericContext,
		);
	const boxed = (r: number): string =>
		reps[r] === "int32"
			? `mal_value_from_i32(r${r})`
			: reps[r] === "number"
				? profileCall("boxing", `mal_ops_number_value(r${r})`)
				: reps[r] === "boolean"
					? profileCall("boxing", `mal_value_new_boolean(r${r})`)
					: `r${r}`;
	const boxedOperand = (operand: number): string => {
		const decoded = decodeVmValueOperand(operand);
		switch (decoded.kind) {
			case "register":
				return boxed(decoded.register);
			case "undefined":
				return "MAL_VALUE_UNDEFINED";
			case "null":
				return "MAL_VALUE_NULL";
			case "boolean":
				return `MAL_VALUE_${decoded.value ? "TRUE" : "FALSE"}`;
			case "number":
				return `mal_value_from_i32(${decoded.value})`;
			case "string":
				return relocation.stringValue(decoded.index, suffix);
		}
	};
	const operandRep = (operand: number): RegisterRep => {
		const decoded = decodeVmValueOperand(operand);
		return decoded.kind === "register"
			? reps[decoded.register]!
			: decoded.kind === "number"
				? "int32"
				: decoded.kind === "boolean" || decoded.kind === "string"
					? decoded.kind
					: "boxed";
	};
	const callValue = (dst: number, value: string): string =>
		reps[dst] === "int32"
			? `mal_ops_number_to_i32(mal_ops_number_as_f64(${value}))`
			: reps[dst] === "number"
				? `mal_ops_number_as_f64(${value})`
				: reps[dst] === "boolean"
					? `mal_value_to_boolean(${value})`
					: value;
	const storeNumber = (dst: number, expression: string): string =>
		`r${dst} = ${reps[dst] === "number" ? expression : reps[dst] === "int32" ? `mal_ops_number_to_i32(${expression})` : profileCall("boxing", `mal_ops_number_value(${expression})`)};`;
	const storeBoolean = (dst: number, expression: string): string =>
		`r${dst} = ${reps[dst] === "boolean" ? expression : profileCall("boxing", `mal_value_new_boolean(${expression})`)};`;
	const fixedCollectionCall = (
		operation: string,
		dst: number,
		receiver: number,
		args: ReadonlyArray<number>,
	): string | null => {
		const key = args[0] === undefined ? "MAL_VALUE_UNDEFINED" : boxedOperand(args[0]);
		const value = args[1] === undefined ? "MAL_VALUE_UNDEFINED" : boxedOperand(args[1]);
		const parameters = `vm, ${boxedOperand(receiver)}, ${key}`;
		switch (operation) {
			case "Map.prototype.get":
				return `r${dst} = mal_builtin_map_get_key(${parameters});`;
			case "Map.prototype.set":
				return `r${dst} = mal_builtin_map_set_key_value(${parameters}, ${value});`;
			case "Map.prototype.has":
				return storeBoolean(dst, `mal_builtin_map_has_key(${parameters})`);
			case "Map.prototype.delete":
				return storeBoolean(dst, `mal_builtin_map_delete_key(${parameters})`);
			case "Set.prototype.add":
				return `r${dst} = mal_builtin_set_add_value(${parameters});`;
			case "Set.prototype.has":
				return storeBoolean(dst, `mal_builtin_set_has_value(${parameters})`);
			case "Set.prototype.delete":
				return storeBoolean(dst, `mal_builtin_set_delete_value(${parameters})`);
			default:
				return null;
		}
	};
	const builtinOperandKind = (operand: number): CompilerValueKindMask | undefined => {
		if (
			nativePlan?.kind !== "exact-builtin-input-kinds" ||
			instruction.opcode !== "CALL_KNOWN"
		)
			return undefined;
		if (operand === instruction.thisValue) return nativePlan.inputKindMasks[0];
		const index = instruction.arguments.indexOf(operand);
		return index < 0 ? undefined : nativePlan.inputKindMasks[index + 1];
	};
	const operandIsString = (operand: number): boolean =>
		operandRep(operand) === "string" ||
		builtinOperandKind(operand) === COMPILER_VALUE_KIND_STRING;

	const nativeNumberOperand = (operand: number): string | null => {
		const decoded = decodeVmValueOperand(operand);
		if (decoded.kind === "register") {
			return isNumericRep(reps[decoded.register]!)
				? num(decoded.register)
				: builtinOperandKind(operand) === COMPILER_VALUE_KIND_NUMBER
					? `mal_ops_number_as_f64(${boxedOperand(operand)})`
					: null;
		}
		return decoded.kind === "number" ? cF64Literal(decoded.value) : null;
	};
	const nativeInt32Operand = (operand: number): string | null => {
		const decoded = decodeVmValueOperand(operand);
		if (decoded.kind === "register") {
			return reps[decoded.register] === "int32"
				? `r${decoded.register}`
				: reps[decoded.register] === "number"
					? `mal_ops_number_to_i32(r${decoded.register})`
					: null;
		}
		return decoded.kind === "number" ? String(decoded.value) : null;
	};
	const nativeBooleanOperand = (operand: number): string | null => {
		const decoded = decodeVmValueOperand(operand);
		if (decoded.kind === "register") {
			return reps[decoded.register] === "boolean"
				? `r${decoded.register}`
				: builtinOperandKind(operand) === COMPILER_VALUE_KIND_BOOLEAN
					? `mal_value_to_boolean(${boxedOperand(operand)})`
					: null;
		}
		return decoded.kind === "boolean" ? (decoded.value ? "true" : "false") : null;
	};
	const coerciveNumberOperand = (operand: number): string | null => {
		const boolean = nativeBooleanOperand(operand);
		return boolean === null ? nativeNumberOperand(operand) : `(${boolean} ? 1.0 : 0.0)`;
	};
	const num = (r: number): string => (reps[r] === "int32" ? `(f64) r${r}` : `r${r}`);
	// Typed Math operands remain numbers when coroutine storage boxes their registers.
	const typedNumber = (r: number): string =>
		reps[r] === "number" || reps[r] === "int32"
			? num(r)
			: `mal_ops_number_as_f64(${boxed(r)})`;
	const exactPrimitiveNumber = (r: number, mask: CompilerValueKindMask): string => {
		const number = isNumericRep(reps[r]!) ? num(r) : `mal_ops_number_as_f64(${boxed(r)})`;
		const boolean = reps[r] === "boolean" ? `r${r}` : `mal_value_to_boolean(${boxed(r)})`;
		const choices: Array<{ mask: number; test: string; value: string }> = [
			{
				mask: COMPILER_VALUE_KIND_UNDEFINED,
				test: `mal_value_is_undefined(${boxed(r)})`,
				value: '__builtin_nan("")',
			},
			{
				mask: COMPILER_VALUE_KIND_NULL,
				test: `mal_value_is_null(${boxed(r)})`,
				value: "0.0",
			},
			{
				mask: COMPILER_VALUE_KIND_BOOLEAN,
				test: `mal_value_is_boolean(${boxed(r)})`,
				value: `(${boolean} ? 1.0 : 0.0)`,
			},
			{ mask: COMPILER_VALUE_KIND_NUMBER, test: "true", value: number },
		].filter((choice) => (mask & choice.mask) !== 0);
		let expression = choices.pop()!.value;
		for (const choice of choices.reverse())
			expression = `(${choice.test} ? ${choice.value} : ${expression})`;
		return expression;
	};
	const truthy = (r: number): string =>
		reps[r] === "boolean"
			? `r${r}`
			: reps[r] === "int32"
				? `(r${r} != 0)`
				: reps[r] === "number"
					? `(r${r} != 0.0 && r${r} == r${r})`
					: reps[r] === "string"
						? `(mal_string_length(mal_value_to_string(r${r})) != 0)`
						: `mal_value_is_truthy(r${r})`;
	// Where control goes on a pending throw: into the innermost enclosing
	// try/catch handler when this instruction is inside one (CATCH there reads
	// vm->completion.value), otherwise out of the compiled frame (the dispatch
	// caller observes vm->completion). Mirrors the interpreter's unwinder.
	// The no-handler case leaves via a single shared per-function `__throw_exit`
	// label (emitted once at the function end by the caller — see THROW_EXIT_*),
	// rather than inlining the unlink+return at every fallible op: the leave-frame
	// epilogue is identical across all sites, so ~one goto per op replaces a full
	// `{ unlink; return; }` copy (a large codesize saving). A goto to an
	// in-function handler keeps the frame live (no unlink); the shared exit unlinks.
	// The value a coroutine's C function returns at an exit: an async function hands
	// back its result promise (meaningful only on the initial synchronous run — a
	// resume's return is ignored); everything else returns undefined.
	const coroReturnValue =
		coro !== null && coro.isAsyncFunction
			? "__async_result_promise"
			: "MAL_VALUE_UNDEFINED";
	const onThrow = (): string =>
		handlerIp !== undefined
			? `goto L${handlerIp};`
			: `goto ${nativeBodyReference(resources, "throwExit")};`;
	const throwCheck = (): string =>
		`if (vm->completion.kind == MAL_COMPLETION_THROW) ${onThrow()}`;
	// A poll without corresponding exact-root metadata can expose dead slots or clear
	// a just-produced result under the preceding instruction's mask.
	const poll =
		context.loopBackedgeInactiveRootMask === undefined
			? context.gcSafepoint
				? "if (mal_gc_poll) mal_gc_safepoint(vm);"
				: ""
			: `if (mal_gc_poll) { ${cInactiveRootMaskPublication(context.loopBackedgeInactiveRootMask)}; mal_gc_safepoint(vm); }`;
	const mathPoll =
		context.mathCallInactiveRootMask === undefined
			? poll
			: `if (mal_gc_poll) { ${cInactiveRootMaskPublication(context.mathCallInactiveRootMask)}; mal_gc_safepoint(vm); }`;
	const mathFallbackRootPublication =
		context.mathCallInactiveRootMask === undefined
			? []
			: [`  ${cInactiveRootMaskPublication(context.mathCallInactiveRootMask)};`];
	// Where `this` is stored: a derived constructor's is a mutable rooted slot
	// (super() rebinds it); everything else reads the immutable `this_value` param.
	const thisRef = thisSlot >= 0 ? `__gc_slots[${thisSlot}]` : "this_value";
	if (nativePlan?.kind === "exact-own-slot" && stackObjectAccess === undefined) {
		switch (instruction.opcode) {
			case "LOAD_PROPERTY_STATIC":
			case "LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT":
				return [
					"MAL_PERF_COUNT(exact_own_slot_loads);",
					`r${instruction.dst} = mal_value_to_object(${boxed(instruction.object)})->slots[${nativePlan.slot}];`,
				];
			case "STORE_PROPERTY_STATIC":
			case "STORE_PROPERTY_STATIC_KNOWN_OWN_SLOT":
				return [
					"MAL_PERF_COUNT(exact_own_slot_stores);",
					`mal_vm_object_slot_store(mal_value_to_object(${boxed(instruction.object)}), ${nativePlan.slot}, ${boxed(instruction.value)});`,
				];
		}
	}
	if (
		nativePlan?.kind === "exact-packed-rest-array-length" &&
		instruction.opcode === "LOAD_PROPERTY_STATIC"
	) {
		const length =
			context.directArgumentRepresentations === undefined
				? `(arg_count > ${nativePlan.startIndex} ? arg_count - ${nativePlan.startIndex} : 0)`
				: String(
						Math.max(
							0,
							context.directArgumentRepresentations.length - nativePlan.startIndex,
						),
					);
		return [storeNumber(instruction.dst, `(f64) ${length}`)];
	}
	if (
		nativePlan?.kind === "exact-array-length" &&
		(instruction.opcode === "LOAD_PROPERTY_STATIC" ||
			instruction.opcode === "LOAD_PROPERTY_STATIC_ARRAY_LENGTH")
	) {
		return [
			reps[instruction.dst] === "number"
				? `r${instruction.dst} = (f64) mal_array_object_length(mal_value_to_array_object(${boxed(instruction.object)}));`
				: `r${instruction.dst} = mal_value_from_u32(mal_array_object_length(mal_value_to_array_object(${boxed(instruction.object)})));`,
		];
	}
	if (
		nativePlan?.kind === "contained-fixed-typed-array-length" &&
		(instruction.opcode === "LOAD_PROPERTY_STATIC" ||
			instruction.opcode === "LOAD_PROPERTY_STATIC_ARRAY_LENGTH")
	) {
		return [
			reps[instruction.dst] === "number"
				? `r${instruction.dst} = (f64) mal_value_to_typed_array_object(${boxed(instruction.object)})->length;`
				: `r${instruction.dst} = mal_value_from_u32(mal_value_to_typed_array_object(${boxed(instruction.object)})->length);`,
		];
	}
	if (
		nativePlan?.kind === "exact-packed-rest-array-element" &&
		instruction.opcode === "LOAD_PROPERTY"
	) {
		const directArguments = context.directArgumentRepresentations;
		if (directArguments !== undefined) {
			const values = directArguments.slice(nativePlan.startIndex);
			if (values.length === 0)
				return [`r${instruction.dst} = ${zeroOf(reps[instruction.dst]!)};`];
			const numeric = isNumericRep(reps[instruction.dst]!) && values.every(isNumericRep);
			const directValue = (representation: VmRegisterRepresentation, index: number) => {
				const parameter = `p${nativePlan.startIndex + index}`;
				if (numeric) return representation === "int32" ? `(f64) ${parameter}` : parameter;
				return representation === "int32"
					? `mal_value_from_i32(${parameter})`
					: representation === "number"
						? `mal_ops_number_value(${parameter})`
						: representation === "boolean"
							? `mal_value_new_boolean(${parameter})`
							: parameter;
			};
			const index = `__rest_index_${ip}`;
			const lines = [
				"MAL_PERF_COUNT(array_contained_element_reads);",
				`u32 ${index} = (u32) ${typedNumber(instruction.key)};`,
				`switch (${index}) {`,
				...values.flatMap((representation, offset) => [
					`case ${offset}: r${instruction.dst} = ${directValue(representation, offset)}; break;`,
				]),
				`default: r${instruction.dst} = ${zeroOf(reps[instruction.dst]!)}; break;`,
				"}",
			];
			if (
				indexedLengthLoopAction?.role === "element" &&
				indexedLengthLoopAction.element?.kind === "load" &&
				indexedLengthLoopAction.element.arrayIndexIsUint32
			)
				return lines;
			const rawIndex = `__rest_raw_index_${ip}`;
			return [
				`f64 ${rawIndex} = ${typedNumber(instruction.key)};`,
				`if (${rawIndex} >= 0.0 && ${rawIndex} < ${values.length}.0 && ${rawIndex} == trunc(${rawIndex})) {`,
				...lines.map((line) => `  ${line}`),
				`} else { r${instruction.dst} = ${zeroOf(reps[instruction.dst]!)}; }`,
			];
		}
		if (
			indexedLengthLoopAction?.role === "element" &&
			indexedLengthLoopAction.element?.kind === "load" &&
			indexedLengthLoopAction.element.arrayIndexIsUint32
		) {
			return [
				"MAL_PERF_COUNT(array_contained_element_reads);",
				`r${instruction.dst} = ${callValue(
					instruction.dst,
					`args[${nativePlan.startIndex} + (u32) ${typedNumber(instruction.key)}]`,
				)};`,
			];
		}
		const index = `__rest_index_${ip}`;
		const length = `__rest_length_${ip}`;
		const value = `__rest_value_${ip}`;
		return [
			"MAL_PERF_COUNT(array_contained_element_reads);",
			`f64 ${index} = ${typedNumber(instruction.key)};`,
			`u32 ${length} = arg_count > ${nativePlan.startIndex} ? (u32) (arg_count - ${nativePlan.startIndex}) : 0;`,
			`MalValue ${value} = MAL_VALUE_UNDEFINED;`,
			`if (${index} >= 0.0 && ${index} < (f64) ${length} && ${index} == trunc(${index})) {`,
			`  ${value} = args[${nativePlan.startIndex} + (u32) ${index}];`,
			`}`,
			`r${instruction.dst} = ${callValue(instruction.dst, value)};`,
		];
	}
	if (
		nativePlan?.kind === "exact-contained-array-element" &&
		instruction.opcode === "LOAD_PROPERTY"
	) {
		const value = `__private_array_element_${ip}`;
		const array = `mal_value_to_array_object(${boxed(instruction.object)})`;
		const load =
			indexedLengthLoopAction?.role === "element" &&
			indexedLengthLoopAction.element?.kind === "load" &&
			indexedLengthLoopAction.element.arrayIndexIsUint32
				? `mal_vm_private_array_try_get_proven_index(${array}, (u32) ${num(instruction.key)}, &${value})`
				: `mal_vm_private_array_try_get_index(${array}, ${num(instruction.key)}, &${value})`;
		return [
			"MAL_PERF_COUNT(array_contained_element_reads);",
			`MalValue ${value};`,
			`if (!${load}) {`,
			`  ${value} = ${profileCall("property", `mal_vm_indexed_fast_load_index(vm, ${boxed(instruction.object)}, ${num(instruction.key)}, &${nativeBodyReference(resources, "propertyCache")}[${instruction.icIndex}])`)};`,
			`  ${throwCheck()}`,
			`}`,
			`r${instruction.dst} = ${callValue(instruction.dst, value)};`,
		];
	}
	if (
		nativePlan?.kind === "exact-typed-array-element" ||
		nativePlan?.kind === "contained-fixed-typed-array-element"
	) {
		const kind = nativeTypedArrayKind(nativePlan.elementKind);
		const elementSize = nativeTypedArrayElementSize(nativePlan.elementKind);
		if (instruction.opcode === "LOAD_PROPERTY") {
			if (
				nativePlan.kind === "contained-fixed-typed-array-element" &&
				nativePlan.inBounds
			) {
				const array = `__typed_load_${ip}`;
				const index = isNumericRep(reps[instruction.key]!)
					? num(instruction.key)
					: `mal_ops_number_as_f64(${boxed(instruction.key)})`;
				const bits = `mal_scalar_load_native_u${elementSize * 8}(${array}->buffer->data + ${array}->byte_offset + (usize)(u32)(${index}) * ${elementSize})`;
				const value =
					nativePlan.elementKind === "Float64Array"
						? `mal_scalar_f64_from_bits(${bits})`
						: nativePlan.elementKind === "Float32Array"
							? `mal_scalar_f32_from_bits(${bits})`
							: nativePlan.elementKind.startsWith("Int")
								? `mal_scalar_i${elementSize * 8}_from_bits(${bits})`
								: bits;
				return [
					`MalTypedArrayObject *${array} = mal_value_to_typed_array_object(${boxed(instruction.object)});`,
					storeNumber(instruction.dst, `(f64)(${value})`),
				];
			}
			const exactLoad = `${nativePlan.kind === "contained-fixed-typed-array-element" ? "mal_vm_contained_fixed_numeric_typed_array_load" : "mal_vm_exact_numeric_typed_array_load"}(mal_value_to_typed_array_object(${boxed(instruction.object)}), mal_vm_typed_array_numeric_index(${isNumericRep(reps[instruction.key]!) ? num(instruction.key) : `mal_ops_number_as_f64(${boxed(instruction.key)})`}), ${kind}, ${elementSize})`;
			if (isNumericRep(reps[instruction.key]!)) {
				return [
					"MAL_PERF_COUNT(exact_typed_array_loads);",
					`r${instruction.dst} = ${exactLoad};`,
				];
			}
			return [
				`if (mal_ops_is_number(${boxed(instruction.key)})) {`,
				"  MAL_PERF_COUNT(exact_typed_array_loads);",
				`  r${instruction.dst} = ${exactLoad};`,
				"} else {",
				`  r${instruction.dst} = ${profileCall("property", `mal_vm_op_load_property_ic(vm, ${boxed(instruction.object)}, ${boxed(instruction.key)}, &${nativeBodyReference(resources, "propertyCache")}[${instruction.icIndex}])`)};`,
				`  ${throwCheck()}`,
				"}",
			];
		}
		if (instruction.opcode === "STORE_PROPERTY") {
			// Containment prevents buffer exposure; numeric operands need no observable coercion.
			if (
				nativePlan.kind === "contained-fixed-typed-array-element" &&
				(nativePlan.inBounds || isNumericRep(reps[instruction.key]!)) &&
				isNumericRep(reps[instruction.value]!)
			) {
				const array = `__typed_store_${ip}`;
				const index = `__typed_store_index_${ip}`;
				const storedBits =
					nativePlan.elementKind === "Uint8ClampedArray"
						? reps[instruction.value] === "int32"
							? `(r${instruction.value} <= 0 ? 0 : r${instruction.value} >= 255 ? 255 : (u8) r${instruction.value})`
							: `mal_typed_array_to_uint8_clamp(${num(instruction.value)})`
						: nativePlan.elementKind === "Float64Array"
							? `mal_scalar_f64_to_bits(${num(instruction.value)})`
							: nativePlan.elementKind === "Float32Array"
								? `mal_scalar_f32_to_bits((f32) ${num(instruction.value)})`
								: `(u${elementSize * 8}) ${nativeInt32Operand(instruction.value)!}`;
				return [
					`MalTypedArrayObject *${array} = mal_value_to_typed_array_object(${boxed(instruction.object)});`,
					`u32 ${index} = ${nativePlan.inBounds ? `(u32)(${isNumericRep(reps[instruction.key]!) ? num(instruction.key) : `mal_ops_number_as_f64(${boxed(instruction.key)})`})` : `mal_vm_typed_array_numeric_index(${num(instruction.key)})`};`,
					...(nativePlan.inBounds ? [] : [`if (${index} < ${array}->length) {`]),
					`  mal_scalar_store_native_u${elementSize * 8}(${array}->buffer->data + ${array}->byte_offset + (usize) ${index} * ${elementSize}, ${storedBits});`,
					...(nativePlan.inBounds ? [] : [`}`]),
				];
			}
			const exactStore = `mal_vm_numeric_typed_array_store_known_receiver(vm, mal_value_to_typed_array_object(${boxed(instruction.object)}), ${isNumericRep(reps[instruction.key]!) ? num(instruction.key) : `mal_ops_number_as_f64(${boxed(instruction.key)})`}, ${boxed(instruction.value)}, ${strict});`;
			if (isNumericRep(reps[instruction.key]!)) return [exactStore, throwCheck()];
			return [
				`if (mal_ops_is_number(${boxed(instruction.key)})) {`,
				`  ${exactStore}`,
				`  ${throwCheck()}`,
				"} else {",
				`  mal_vm_indexed_fast_store(vm, ${boxed(instruction.object)}, ${boxed(instruction.key)}, ${boxed(instruction.value)}, ${strict}, &${nativeBodyReference(resources, "propertyCache")}[${instruction.icIndex}]);`,
				`  ${throwCheck()}`,
				"}",
			];
		}
	}
	if (context.fieldLoad !== undefined && instruction.opcode === "LOAD_PROPERTY_STATIC")
		return [storeNumber(instruction.dst, `fp${context.fieldLoad}`)];
	if (
		context.fieldAllocation !== undefined &&
		instruction.opcode === "CREATE_OBJECT_SHAPED"
	) {
		const site = context.fieldAllocation;
		return [
			...instruction.valueRegisters.map((register, field) => {
				const slot = site.boxedSlots[field];
				return slot === undefined
					? `__field_${ip}_${field} = ${isNumericRep(reps[register]!) ? num(register) : `mal_ops_number_as_f64(${boxed(register)})`};`
					: `__gc_slots[${slot}] = ${boxed(register)};`;
			}),
			`r${instruction.dst} = MAL_VALUE_UNDEFINED;`,
		];
	}
	if (context.fieldCall !== undefined && instruction.opcode === "CALL") {
		const site = context.fieldCall;
		const targets = site.entries.filter((entry) =>
			directCompiledEntries.has(
				directCompiledEntryKey(entry.functionIndex, entry.entryId),
			),
		);
		const callee = boxedOperand(instruction.callee);
		const index = `__field_target_${ip}`;
		const shape = `__field_shape_${ip}`;
		const keys = site.allocation.keyStringIndices
			.map((key) => `vm->string_constant_atoms[${relocation.stringIndex(key)}]`)
			.join(", ");
		const values = site.allocation.keyStringIndices
			.map((_, field) =>
				site.boxedSlots[field] === undefined
					? `mal_ops_number_value(__field_${site.allocationIp}_${field})`
					: `__gc_slots[${site.boxedSlots[field]}]`,
			)
			.join(", ");
		const rest = emitInstruction(
			instruction,
			ip,
			suffix,
			reps,
			strict,
			handlerIp,
			gcUnlink,
			thisSlot,
			coro,
			{ ...context, fieldCall: undefined, fieldEntryCall: site },
		);
		if (rest === null) return null;
		return [
			`i32 ${index} = mal_value_is_function_object(${callee}) ? mal_function_object_function_index(mal_value_to_function_object(${callee})) : -1;`,
			`if (!(${targets.map((target) => `${index} == ${relocation.functionIndex(target.functionIndex)}`).join(" || ") || "false"})) {`,
			`  MalShape *${shape} = ${nativeBodyReference(resources, "literalShapes")}[${site.allocation.shapeCacheIndex}];`,
			`  if (${shape} == nullptr) { ${shape} = mal_shape_from_string_keys(&vm->heap,(MalString *[]){${keys}},${site.allocation.count}); ${nativeBodyReference(resources, "literalShapes")}[${site.allocation.shapeCacheIndex}] = ${shape}; }`,
			`  r${site.allocation.dst} = mal_vm_create_object_shaped(vm,${shape},(MalValue[]){${values}},${site.allocation.count});`,
			`}`,
			...rest,
			...site.boxedSlots.flatMap((slot) =>
				slot === undefined ? [] : [`__gc_slots[${slot}] = MAL_VALUE_UNDEFINED;`],
			),
		];
	}
	switch (instruction.opcode) {
		case "MOVE": {
			if (staticPropertyNumericAction?.role === "skip") {
				const fallback = emitGenericInstruction();
				if (fallback === null) return null;
				return [
					`if (!__property_projection_${staticPropertyNumericAction.plan.id}_fast) {`,
					...fallback.map((line) => `  ${line}`),
					`}`,
				];
			}
			// A move is also the explicit representation-conversion seam.
			const dst = instruction.dst;
			const read =
				reps[dst] === "int32"
					? reps[instruction.src] === "int32"
						? `r${instruction.src}`
						: reps[instruction.src] === "number"
							? `mal_ops_number_to_i32(r${instruction.src})`
							: `mal_ops_number_to_i32(mal_ops_number_as_f64(${boxed(instruction.src)}))`
					: reps[dst] === "number"
						? reps[instruction.src] === "number"
							? num(instruction.src)
							: reps[instruction.src] === "int32"
								? num(instruction.src)
								: `mal_ops_number_as_f64(${boxed(instruction.src)})`
						: reps[dst] === "boolean"
							? reps[instruction.src] === "boolean"
								? truthy(instruction.src)
								: `mal_value_to_boolean(${boxed(instruction.src)})`
							: boxed(instruction.src);
			return [`r${dst} = ${read};`];
		}
		case "BASE_CONSTRUCT_RESULT":
			return [
				`r${instruction.dst} = mal_value_is_object(${boxed(instruction.value)}) ? ${boxed(instruction.value)} : ${boxed(instruction.receiver)};`,
			];
		case "CREATE_UNDEFINED":
			return [`r${instruction.dst} = MAL_VALUE_UNDEFINED;`];
		case "CREATE_NULL":
			return [`r${instruction.dst} = MAL_VALUE_NULL;`];
		case "CREATE_EMPTY":
			// The TDZ hole sentinel. Target lowering always gives the destination a
			// boxed representation, so a number/boolean register never holds it.
			return [`r${instruction.dst} = MAL_VALUE_EMPTY;`];
		case "THROW_IF_TDZ": {
			if (staticPropertyNumericAction?.role === "skip") {
				const fallback = emitGenericInstruction();
				if (fallback === null) return null;
				return [
					`if (!__property_projection_${staticPropertyNumericAction.plan.id}_fast) {`,
					...fallback.map((line) => `  ${line}`),
					`}`,
				];
			}
			// Read-before-initialization check on a let/const/class binding. The
			// helper throws (setting the completion) only on the empty sentinel; a
			// throw propagates out, exactly like the interpreter op.
			return [
				`if (mal_value_is_empty(${boxed(instruction.src)})) {`,
				...(context.tdzInactiveRootMask === undefined
					? []
					: [`  ${cInactiveRootMaskPublication(context.tdzInactiveRootMask)};`]),
				`  mal_vm_op_throw_if_tdz(vm, ${boxed(instruction.src)}, ${relocation.stringIndex(instruction.nameStringIndex)});`,
				`  ${throwCheck()}`,
				`}`,
			];
		}
		case "IS_EMPTY":
			if (reps[instruction.src] !== "boxed")
				return [storeBoolean(instruction.dst, "false")];
			return [
				reps[instruction.dst] === "boolean"
					? `r${instruction.dst} = mal_value_is_empty(${boxed(instruction.src)});`
					: `r${instruction.dst} = ${profileCall("boxing", `mal_value_new_boolean(mal_value_is_empty(${boxed(instruction.src)}))`)};`,
			];
		case "CREATE_BOOLEAN":
			return [
				reps[instruction.dst] === "boolean"
					? `r${instruction.dst} = ${instruction.value ? "true" : "false"};`
					: `r${instruction.dst} = ${profileCall("boxing", `mal_value_new_boolean(${instruction.value ? "true" : "false"})`)};`,
			];
		case "CREATE_NUMBER":
			return [
				reps[instruction.dst] === "int32"
					? `r${instruction.dst} = ${instruction.value};`
					: reps[instruction.dst] === "number"
						? `r${instruction.dst} = ${instruction.value};`
						: `r${instruction.dst} = mal_value_from_i32(${instruction.value});`,
			];
		case "CREATE_F64":
			return [
				reps[instruction.dst] === "int32"
					? `r${instruction.dst} = (i32) ${cF64Literal(instruction.value)};`
					: reps[instruction.dst] === "number"
						? `r${instruction.dst} = ${cF64Literal(instruction.value)};`
						: `r${instruction.dst} = mal_value_from_f64_convert_nan(${cF64Literal(instruction.value)});`,
			];
		case "CREATE_STRING":
			return [
				`r${instruction.dst} = ${relocation.stringValue(instruction.stringIndex, suffix)};`,
			];
		case "CREATE_BIGINT":
			return [
				`r${instruction.dst} = ${relocation.bigintValue(instruction.bigintIndex, suffix)};`,
			];
		case "CREATE_OBJECT":
			if (stackObjectSite === undefined) {
				return [
					`r${instruction.dst} = ${profileCall("allocation", `mal_vm_op_create_object(vm)`)};`,
					throwCheck(),
				];
			}
			if (stackObjectSite.elided === true) {
				return [`r${instruction.dst} = MAL_VALUE_UNDEFINED;`];
			}
			return [
				"mal_perf_stack_object_init();",
				`${stackObjectSite.objectName} = (MalObject){ .header = MAL_HEAP_HEADER_IMMORTAL(MAL_HEAP_OBJECT), .extensible = true, .shape = mal_shape_root(&vm->heap), .prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]), .slots = nullptr, .overflow = nullptr };`,
				`r${instruction.dst} = mal_value_from_object(&${stackObjectSite.objectName});`,
			];
		case "CREATE_BASE_CONSTRUCT_RECEIVER":
			return [
				`r${instruction.dst} = ${profileCall("allocation", `mal_vm_op_create_base_construct_receiver(vm, ${boxed(instruction.newTarget)}, ${instruction.constructorSlotReserve})`)};`,
				throwCheck(),
			];
		case "CREATE_OBJECT_SHAPED": {
			if (stackObjectSite?.elided === true) {
				return [`r${instruction.dst} = MAL_VALUE_UNDEFINED;`];
			}
			// Build the literal's shape once in the VM-owned dense site row and
			// create the object directly in it — no per-property defines.
			const keys = instruction.keyStringIndices
				.map((ki) => `vm->string_constant_atoms[${relocation.stringIndex(ki)}]`)
				.join(", ");
			const values = instruction.valueRegisters.map((r) => boxed(r)).join(", ");
			const shape = [
				`MalShape *__oshape_${ip} = ${nativeBodyReference(resources, "literalShapes")}[${instruction.shapeCacheIndex}];`,
				`if (__oshape_${ip} == nullptr) { __oshape_${ip} = mal_shape_from_string_keys(&vm->heap, (MalString *[]){ ${keys} }, ${instruction.count}); ${nativeBodyReference(resources, "literalShapes")}[${instruction.shapeCacheIndex}] = __oshape_${ip}; }`,
			];
			if (stackObjectSite === undefined) {
				return [
					...shape,
					`r${instruction.dst} = ${profileCall("allocation", `mal_vm_create_object_shaped(vm, __oshape_${ip}, (MalValue[]){ ${values} }, ${instruction.count})`)};`,
				];
			}
			const { objectName, slotsOffset } = stackObjectSite;
			if (stackObjectSite.inheritedLoadInstructionIndex !== undefined) {
				const fastName = stackObjectSite.inheritedFastName!;
				const inheritedValue = stackObjectSite.inheritedValueName!;
				const icName = `${objectName}_inherited_ic`;
				const prototypeName = `${objectName}_prototype`;
				return [
					...shape,
					`MalInlineCache *${icName} = &${nativeBodyReference(resources, "propertyCache")}[${stackObjectSite.inheritedIcIndex}];`,
					`MalObject *${prototypeName} = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]);`,
					`${fastName} = ${icName}->mode == MAL_IC_MODE_INHERITED_VALUE && ${icName}->shape == __oshape_${ip} && ((${icName}->poly_count > 0 && ${icName}->proto_object[0] == ${prototypeName}) || (${icName}->poly_count == 0 && ${inheritedStackObjectProtectorGuard(stackObjectSite)} && ${icName}->receiver_type == MAL_HEAP_OBJECT && ${icName}->obj == ${prototypeName}));`,
					`if (${fastName}) {`,
					`  ${inheritedValue} = ${icName}->value;`,
					`  mal_perf_stack_object_init();`,
					`  mal_perf_stack_object_inherited_fast_init();`,
					`  ${objectName} = (MalObject){ .header = MAL_HEAP_HEADER_IMMORTAL(MAL_HEAP_OBJECT), .extensible = true, .shape = __oshape_${ip}, .prototype = ${prototypeName}, .slots = &__gc_slots[${slotsOffset!}], .overflow = nullptr };`,
					...instruction.valueRegisters.map(
						(register, index) =>
							`  ${stackObjectSlotReference(stackObjectSite, index)} = ${boxed(register)};`,
					),
					`  r${instruction.dst} = mal_value_from_object(&${objectName});`,
					`} else {`,
					`  mal_perf_stack_object_inherited_heap_fallback();`,
					`  r${instruction.dst} = ${profileCall("allocation", `mal_vm_create_object_shaped(vm, __oshape_${ip}, (MalValue[]){ ${values} }, ${instruction.count})`)};`,
					`}`,
				];
			}
			return [
				...shape,
				// Direct initialization is essential: this storage never enters the heap,
				// and IMMORTAL+WHITE makes tracing/finalization/remembering skip the header.
				"mal_perf_stack_object_init();",
				`${objectName} = (MalObject){ .header = MAL_HEAP_HEADER_IMMORTAL(MAL_HEAP_OBJECT), .extensible = true, .shape = __oshape_${ip}, .prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]), .slots = ${stackObjectSite.scalarSlot === undefined ? `&__gc_slots[${slotsOffset!}]` : "nullptr"}, .overflow = nullptr };`,
				...instruction.valueRegisters.map(
					(register, index) =>
						`${stackObjectSlotReference(stackObjectSite, index)} = ${stackObjectSite.scalarSlot === undefined ? boxed(register) : `r${register}`};`,
				),
				`r${instruction.dst} = mal_value_from_object(&${objectName});`,
			];
		}
		case "CREATE_ARRAY":
			if (nativePlan?.kind === "fresh-dense-reserve") {
				return [
					`r${instruction.dst} = ${profileCall("allocation", `mal_vm_op_create_array(vm, ${instruction.length})`)};`,
					`(void) mal_vm_try_fresh_dense_indexed_fill_reserve(vm, r${instruction.dst}, ${nativePlan.length});`,
				];
			}
			return [
				`r${instruction.dst} = ${profileCall("allocation", `mal_vm_op_create_array(vm, ${instruction.length})`)};`,
			];
		case "INSTANTIATE_LITERAL_TEMPLATE": {
			const instantiate = `r${instruction.dst} = mal_vm_instantiate_literal_template(vm, ${relocation.templateOffset(instruction.templateOffset)}, ${instruction.cacheSlot === undefined ? "-1" : relocation.globalIndex(instruction.cacheSlot)});`;
			if (instruction.cacheSlot !== undefined)
				return [
					`r${instruction.dst} = vm->globals[${relocation.globalIndex(instruction.cacheSlot)}];`,
					`if (mal_value_is_undefined(r${instruction.dst})) {`,
					instantiate,
					throwCheck(),
					"}",
				];
			return [instantiate, throwCheck()];
		}
		case "QUERY_STATIC_DATA":
			return [
				`r${instruction.dst} = ${profileCall(instruction.queryKind === "has-own" ? "property" : "call", `mal_vm_query_static_data(vm, ${relocation.templateOffset(instruction.templateOffset)}, ${staticDataQueryTag(instruction.queryKind)}, ${boxed(instruction.needle)}, ${boxed(instruction.fromIndex)})`)};`,
				throwCheck(),
			];
		case "CREATE_FUNCTION":
			// The closure captures this frame's environment. Only reachable when
			// the enclosing function has no captured slots of its own (see the
			// capturedCount guard in emitCompiledFunction), so `env` — the
			// enclosing function's creation_env — is exactly what its interpreted
			// frame's env would be, making the closure's creation_env correct.
			return [
				`r${instruction.dst} = mal_vm_op_create_function(vm, ${relocation.functionIndex(instruction.functionIndex)}, env);`,
			];
		case "DEFINE_PROPERTY": {
			const stringIndex = context.staticDefineStringIndexByIp.get(ip);
			if (stringIndex !== undefined) {
				const cache = `&__dpc_${ip}`;
				return [
					`static MalDefinePropertyCache __dpc_${ip};`,
					`if (!mal_vm_try_define_property_static_cached(vm, ${cache}, ${boxed(instruction.object)}, ${boxed(instruction.value)}, ${instruction.enumerable}, ${instruction.writable}, ${instruction.configurable})) {`,
					`  mal_vm_op_define_property_static_cached(vm, ${cache}, ${boxed(instruction.object)}, ${relocation.stringIndex(stringIndex)}, ${boxed(instruction.value)}, ${instruction.enumerable}, ${instruction.writable}, ${instruction.configurable});`,
					`  ${throwCheck()}`,
					`}`,
				];
			}
			return [
				`mal_vm_op_define_property(vm, ${boxed(instruction.object)}, ${boxed(instruction.key)}, ${boxed(instruction.value)}, ${instruction.enumerable}, ${instruction.writable}, ${instruction.configurable});`,
				throwCheck(),
			];
		}
		case "DEFINE_ACCESSOR":
			// Object-literal / class getter or setter; no user code run.
			return [
				`mal_vm_op_define_accessor(vm, ${boxed(instruction.object)}, ${boxed(instruction.key)}, ${boxed(instruction.accessor)}, ${instruction.enumerable}, ${instruction.isSetter});`,
			];
		case "SET_PROTOTYPE":
			// Object-literal `__proto__:` member / class heritage; no user code run.
			return [
				`mal_vm_op_set_prototype(vm, ${boxed(instruction.object)}, ${boxed(instruction.prototype)}, ${instruction.literal});`,
			];
		case "MERGE_DATA_PROPERTIES":
			// Object spread `{...src}`: a source getter can throw, so propagate.
			return [
				`mal_vm_op_merge_data_properties(vm, ${boxed(instruction.target)}, ${boxed(instruction.src)});`,
				throwCheck(),
			];
		case "DELETE_PROPERTY":
			// `delete object[key]`; a strict-mode failed delete throws.
			return [
				`r${instruction.dst} = mal_vm_op_delete_property(vm, ${boxed(instruction.object)}, ${boxed(instruction.key)}, ${strict});`,
				throwCheck(),
			];
		case "LOAD_THIS":
			// A derived constructor's `this` is in a TDZ until super() binds it, so a
			// read before then is a ReferenceError; an ordinary function's `this` is
			// always initialized and reads straight from the parameter.
			return thisSlot >= 0
				? [`r${instruction.dst} = mal_vm_op_get_this(vm, ${thisRef});`, throwCheck()]
				: [`r${instruction.dst} = this_value;`];
		case "LOAD_NEW_TARGET":
			return [`r${instruction.dst} = ${nativeBodyReference(resources, "newTarget")};`];
		case "GUARD_FUNCTION_INDEX":
			if (reps[instruction.callee] !== "boxed")
				return [storeBoolean(instruction.dst, "false")];
			return [
				`r${instruction.dst} = mal_vm_callee_has_index(vm, ${boxed(instruction.callee)}, ${relocation.functionIndex(instruction.functionIndex)});`,
			];
		case "GUARD_BASE_CONSTRUCTOR_LAYOUT":
			if (reps[instruction.callee] !== "boxed")
				return [storeBoolean(instruction.dst, "false")];
			return [
				`r${instruction.dst} = mal_vm_guard_base_constructor_layout(vm, ${boxed(instruction.callee)}, ${relocation.functionIndex(instruction.functionIndex)}, ${instruction.keyStringIndices.length}, (const i32[]){ ${instruction.keyStringIndices.map((index) => relocation.stringIndex(index)).join(", ")} }, &${nativeBodyReference(resources, "propertyCache")}[${instruction.icIndex}]);`,
			];
		case "LOAD_CALLEE":
			// The invoked closure — used to initialize a named function expression's
			// own-name binding. Only emitted in the entry prologue, so `callee` is the
			// fresh-call parameter (a coroutine resume skips the prologue).
			return [`r${instruction.dst} = callee;`];
		case "LOAD_CAPTURED": {
			if (instruction.ownerFunctionIndex === context.ownedCaptureFunctionIndex)
				return [`r${instruction.dst} = env->slots[${instruction.index}];`];
			return [
				`r${instruction.dst} = mal_vm_load_captured(env, ${relocation.ownerFunctionIndex(instruction.ownerFunctionIndex)}, ${instruction.index});`,
			];
		}
		case "STORE_CAPTURED": {
			if (instruction.ownerFunctionIndex === context.ownedCaptureFunctionIndex)
				return [
					`mal_gc_write_barrier(env->slots[${instruction.index}]);`,
					`env->slots[${instruction.index}] = ${boxed(instruction.src)};`,
					`mal_gc_card(&env->header, env->slots[${instruction.index}]);`,
				];
			return [
				`mal_vm_store_captured(env, ${relocation.ownerFunctionIndex(instruction.ownerFunctionIndex)}, ${instruction.index}, ${boxed(instruction.src)});`,
			];
		}
		case "ENV_PUSH":
		case "ENV_COPY":
		case "ENV_POP": {
			// Per-iteration loop env: reassign the `env` local (the body's
			// LOAD/STORE_CAPTURED + CREATE_FUNCTION read it) and keep the root frame's
			// env pointer current so the GC roots the live env chain. A capturing loop
			// always has a root frame (it creates a closure → a MalValue register).
			const frameUpdate = gcUnlink !== "" ? " __gc_frame.env = env;" : "";
			if (instruction.opcode === "ENV_POP") {
				return [`env = env->parent;${frameUpdate}`];
			}
			if (instruction.opcode === "ENV_PUSH") {
				return [
					`env = mal_env_new(vm, env, ${instruction.scopeId}, ${instruction.slotCount});${frameUpdate}`,
				];
			}
			// ENV_COPY: fresh sibling env (same parent), bindings copied forward. The
			// old env stays rooted via __gc_frame.env until the reassignment below.
			return [
				`{ MalEnv *__old_env = env; env = mal_env_new(vm, __old_env->parent, ${instruction.scopeId}, ${instruction.slotCount}); for (i32 __i = 0; __i < ${instruction.slotCount}; __i++) env->slots[__i] = __old_env->slots[__i]; }${frameUpdate}`,
			];
		}
		case "LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT": {
			if (stackObjectAccess !== undefined) {
				const { site, slot } = stackObjectAccess;
				return [`r${instruction.dst} = ${stackObjectSlotReference(site, slot)};`];
			}
			const candidates = instruction.candidates.flatMap((candidate) => [
				relocation.functionIndex(candidate.shapeFunctionIndex),
				candidate.shapeCacheIndex,
				candidate.slot,
			]);
			return [
				`MalValue __known_own_slot_${ip};`,
				`${relocation.enabled ? "" : "static "}const i32 __known_own_slot_candidates_${ip}[] = { ${candidates.join(", ")} };`,
				`if (mal_vm_try_load_known_own_slots(vm, ${boxed(instruction.object)}, &${nativeBodyReference(resources, "propertyCache")}[${instruction.icIndex}], ${instruction.candidates.length}, __known_own_slot_candidates_${ip}, &__known_own_slot_${ip})) {`,
				`  r${instruction.dst} = __known_own_slot_${ip};`,
				`} else {`,
				...(context.knownOwnSlotLoadInactiveRootMask === undefined
					? []
					: [
							`  ${cInactiveRootMaskPublication(context.knownOwnSlotLoadInactiveRootMask)};`,
						]),
				`  r${instruction.dst} = ${profileCall("property", `mal_vm_op_load_property_ic(vm, ${boxed(instruction.object)}, mal_value_from_string(vm->string_constant_atoms[${relocation.stringIndex(instruction.stringIndex)}]), &${nativeBodyReference(resources, "propertyCache")}[${instruction.icIndex}])`)};`,
				`  ${throwCheck()}`,
				`}`,
			];
		}
		case "SELECT_SHAPE_CASE": {
			const candidates = instruction.candidates.flatMap((candidate) => [
				relocation.functionIndex(candidate.shapeFunctionIndex),
				candidate.shapeCacheIndex,
			]);
			const selected = `mal_vm_select_shape_case(vm, ${boxed(instruction.object)}, ${instruction.candidates.length}, __shape_case_candidates_${ip})`;
			return [
				`${relocation.enabled ? "" : "static "}const i32 __shape_case_candidates_${ip}[] = { ${candidates.join(", ")} };`,
				reps[instruction.dst] === "number"
					? `r${instruction.dst} = (f64) ${selected};`
					: `r${instruction.dst} = mal_value_from_i32(${selected});`,
			];
		}
		case "LOAD_PROPERTY_STATIC_SHAPE_CASE": {
			const selected =
				reps[instruction.shapeCase] === "number"
					? `(i32) r${instruction.shapeCase}`
					: `(mal_value_is_int32(r${instruction.shapeCase}) ? mal_value_to_i32(r${instruction.shapeCase}) : -1)`;
			return [
				`MalValue __shape_case_value_${ip};`,
				`static const i32 __shape_case_slots_${ip}[] = { ${instruction.slots.join(", ")} };`,
				`if (mal_vm_try_load_shape_case(${boxed(instruction.object)}, ${selected}, ${instruction.slots.length}, __shape_case_slots_${ip}, &__shape_case_value_${ip})) {`,
				`  r${instruction.dst} = __shape_case_value_${ip};`,
				`} else {`,
				`  r${instruction.dst} = ${profileCall("property", `mal_vm_op_load_property_ic(vm, ${boxed(instruction.object)}, mal_value_from_string(vm->string_constant_atoms[${relocation.stringIndex(instruction.stringIndex)}]), &${nativeBodyReference(resources, "propertyCache")}[${instruction.icIndex}])`)};`,
				`  ${throwCheck()}`,
				`}`,
			];
		}
		case "STORE_PROPERTY_STATIC_KNOWN_OWN_SLOT": {
			if (stackObjectAccess !== undefined) {
				const { site, slot } = stackObjectAccess;
				return [
					`${stackObjectSlotReference(site, slot)} = ${site.scalarSlot === undefined ? boxed(instruction.value) : `r${instruction.value}`};`,
				];
			}
			const candidates = instruction.candidates.flatMap((candidate) => [
				relocation.functionIndex(candidate.shapeFunctionIndex),
				candidate.shapeCacheIndex,
				candidate.slot,
			]);
			return [
				`${relocation.enabled ? "" : "static "}const i32 __known_own_slot_store_candidates_${ip}[] = { ${candidates.join(", ")} };`,
				`if (!mal_vm_try_store_known_own_slots(vm, ${boxed(instruction.object)}, ${boxed(instruction.value)}, &${nativeBodyReference(resources, "propertyCache")}[${instruction.icIndex}], ${instruction.candidates.length}, __known_own_slot_store_candidates_${ip})) {`,
				`  ${profileCall("property", `mal_vm_op_store_property_ic(vm, ${boxed(instruction.object)}, mal_value_from_string(vm->string_constant_atoms[${relocation.stringIndex(instruction.stringIndex)}]), ${boxed(instruction.value)}, ${strict}, &${nativeBodyReference(resources, "propertyCache")}[${instruction.icIndex}])`)};`,
				`  ${throwCheck()}`,
				`}`,
			];
		}
		case "LOAD_PROPERTY_STATIC_ARRAY_LENGTH": {
			const direct =
				reps[instruction.dst] === "number"
					? `(f64) mal_array_object_length(mal_value_to_array_object(${boxed(instruction.object)}))`
					: `mal_value_from_u32(mal_array_object_length(mal_value_to_array_object(${boxed(instruction.object)})))`;
			return [
				`if (mal_value_is_heap_type(${boxed(instruction.object)}, MAL_HEAP_ARRAY_OBJECT)) {`,
				`  r${instruction.dst} = ${direct};`,
				`} else {`,
				`  r${instruction.dst} = ${profileCall("property", `mal_vm_op_load_property_ic(vm, ${boxed(instruction.object)}, mal_value_from_string(vm->string_constant_atoms[${relocation.stringIndex(instruction.stringIndex)}]), &${nativeBodyReference(resources, "propertyCache")}[${instruction.icIndex}])`)};`,
				`  ${throwCheck()}`,
				`}`,
			];
		}
		case "LOAD_PROPERTY":
		case "LOAD_PROPERTY_STATIC": {
			if (
				instruction.opcode === "LOAD_PROPERTY_STATIC" &&
				staticPropertyNumericAction?.role === "load"
			) {
				const fallback = emitGenericInstruction();
				if (fallback === null) return null;
				const { plan, index } = staticPropertyNumericAction;
				if (index !== 0) {
					return [
						`if (!__property_projection_${plan.id}_fast) {`,
						...fallback.map((line) => `  ${line}`),
						`}`,
					];
				}
				const helper =
					plan.loads.length === 2
						? "mal_vm_property_try_load_static_number_pair"
						: plan.loads.length === 3
							? "mal_vm_property_try_load_static_number_triple"
							: "mal_vm_property_try_load_static_number_quad";
				const cacheArguments = plan.loads.map(
					(load) =>
						`&${nativeBodyReference(resources, "propertyCache")}[${load.instruction.icIndex}]`,
				);
				const valueArguments = plan.loads.map(
					(_load, valueIndex) => `&__property_projection_${plan.id}_value_${valueIndex}`,
				);
				return [
					`__property_projection_${plan.id}_fast = ${helper}(${boxed(instruction.object)}, ${[...cacheArguments, ...valueArguments].join(", ")});`,
					`if (!__property_projection_${plan.id}_fast) {`,
					...fallback.map((line) => `  ${line}`),
					`}`,
				];
			}
			if (
				instruction.opcode === "LOAD_PROPERTY_STATIC" &&
				staticPropertyProjectionAction !== undefined
			) {
				const fallback = emitGenericInstruction();
				if (fallback === null) return null;
				const { projection, role } = staticPropertyProjectionAction;
				const id = projection.firstIp;
				const value = `__property_projection_${id}_${role}`;
				if (role === "second") {
					return [
						`if (__property_projection_${id}_fast) {`,
						`  r${instruction.dst} = ${value};`,
						`} else {`,
						...fallback.map((line) => `  ${line}`),
						`}`,
					];
				}
				return [
					`__property_projection_${id}_fast = mal_vm_property_try_load_static_pair(${boxed(instruction.object)}, &${nativeBodyReference(resources, "propertyCache")}[${projection.first.icIndex}], &${nativeBodyReference(resources, "propertyCache")}[${projection.second.icIndex}], &__property_projection_${id}_first, &__property_projection_${id}_second);`,
					`if (__property_projection_${id}_fast) {`,
					`  r${instruction.dst} = ${value};`,
					`} else {`,
					...fallback.map((line) => `  ${line}`),
					`}`,
				];
			}
			if (
				instruction.opcode === "LOAD_PROPERTY_STATIC" &&
				nativeBuiltinCollectionCallChainAction?.role === "property"
			) {
				const fallback = emitGenericInstruction();
				if (fallback === null) return null;
				return [
					`if (!mal_vm_try_capture_collection_method(vm, ${nativeBuiltinCollectionOperation(nativeBuiltinCollectionCallChainAction.chain.operation)}, ${boxed(instruction.object)}, &r${instruction.dst})) {`,
					...fallback.map((line) => `  ${line}`),
					`}`,
				];
			}
			if (
				instruction.opcode === "LOAD_PROPERTY_STATIC" &&
				nativeStringCharCodeAtChainAction?.role === "property"
			) {
				const { chain } = nativeStringCharCodeAtChainAction;
				const captured = `__string_char_code_at_${chain.callIp}_captured`;
				const receiver = boxed(instruction.object);
				const primitive =
					reps[instruction.object] === "string"
						? "true"
						: `mal_value_is_string(${receiver})`;
				const capture =
					chain.methodIdentity === "authority-invariant"
						? primitive
						: `${primitive} && mal_vm_local_watched_primitive_value_try_load_static(vm, __watched_methods_epoch, MAL_PRIM_KIND_STRING, &${nativeBodyReference(resources, "propertyCache")}[${instruction.icIndex}], &r${instruction.dst})`;
				return [
					`${captured} = ${capture};`,
					`if (${captured}) {`,
					...(chain.methodIdentity === "authority-invariant"
						? [`  r${instruction.dst} = MAL_VALUE_UNDEFINED;`]
						: []),
					`} else {`,
					`  r${instruction.dst} = ${profileCall("property", `mal_vm_op_load_property_ic(vm, ${receiver}, mal_value_from_string(vm->string_constant_atoms[${relocation.stringIndex(instruction.stringIndex)}]), &${nativeBodyReference(resources, "propertyCache")}[${instruction.icIndex}])`)};`,
					`  ${throwCheck()}`,
					`}`,
				];
			}
			if (
				instruction.opcode === "LOAD_PROPERTY_STATIC" &&
				(nativeStringSplitProjectionAction?.role === "property" ||
					nativeStringSplitCursorAction?.role === "property" ||
					nativeStringSliceNumberFusionAction?.role === "property" ||
					nativeRegExpExecProjectionAction?.role === "property")
			) {
				return [];
			}
			if (
				instruction.opcode === "LOAD_PROPERTY_STATIC" &&
				nativeRegExpExecProjectionAction?.role === "caseUpperProperty"
			) {
				const { site, load } = nativeRegExpExecProjectionAction;
				const slot = site.loads.findIndex((entry) => entry.ip === load?.ip);
				if (slot >= 0 && load?.consumer?.kind === "asciiCaseLength") {
					const fast = `__regexp_exec_${site.projection.callIp}_case_${load.consumer.upperCallIp}_fast`;
					const length = `__regexp_exec_${site.projection.callIp}_case_${load.consumer.upperCallIp}_length`;
					const start = `__regexp_exec_${site.projection.callIp}_starts[${slot}]`;
					const end = `__regexp_exec_${site.projection.callIp}_ends[${slot}]`;
					const authorityInvariant =
						load.consumer.methodIdentity === "authority-invariant";
					const lower = `__regexp_exec_${site.projection.callIp}_case_lower_${load.consumer.upperCallIp}`;
					const summary = authorityInvariant
						? profileCall(
								"string",
								`mal_builtin_string_ascii_case_chain_length_span_locked(vm, __gc_slots[${site.subjectSlot}], ${start}, ${end}, &${length})`,
							)
						: `mal_vm_local_watched_primitive_value_try_load_static(vm, __watched_methods_epoch, MAL_PRIM_KIND_STRING, &${nativeBodyReference(resources, "propertyCache")}[${instruction.icIndex}], &r${instruction.dst}) && mal_vm_local_watched_primitive_value_try_load_static(vm, __watched_methods_epoch, MAL_PRIM_KIND_STRING, &${nativeBodyReference(resources, "propertyCache")}[${load.consumer.lowerIcIndex}], &${lower}) && ${profileCall("string", `mal_builtin_string_ascii_case_chain_length_span(vm, r${instruction.dst}, ${lower}, __gc_slots[${site.subjectSlot}], ${start}, ${end}, &${length})`)}`;
					return [
						...(authorityInvariant ? [] : [`MalValue ${lower};`]),
						`${fast} = __regexp_exec_${site.projection.callIp}_projected && ${start} >= 0 && ${summary};`,
						`if (!${fast}) {`,
						`  if (__regexp_exec_${site.projection.callIp}_projected && ${start} >= 0) {`,
						`    __gc_slots[${site.slotsOffset + slot}] = ${profileCall("regexp", `mal_regexp_materialize_capture_span(vm, __gc_slots[${site.subjectSlot}], ${start}, ${end})`)};`,
						`    r${instruction.object} = __gc_slots[${site.slotsOffset + slot}];`,
						`  }`,
						`  r${instruction.dst} = ${profileCall("property", `mal_vm_op_load_property_ic(vm, ${boxedOperand(instruction.object)}, mal_value_from_string(vm->string_constant_atoms[${relocation.stringIndex(instruction.stringIndex)}]), &${nativeBodyReference(resources, "propertyCache")}[${instruction.icIndex}])`)};`,
						`  ${throwCheck()}`,
						`}`,
					];
				}
			}
			if (
				instruction.opcode === "LOAD_PROPERTY_STATIC" &&
				nativeRegExpExecProjectionAction?.role === "caseLowerProperty"
			) {
				const { site, load } = nativeRegExpExecProjectionAction;
				if (load?.consumer?.kind === "asciiCaseLength") {
					const fast = `__regexp_exec_${site.projection.callIp}_case_${load.consumer.upperCallIp}_fast`;
					return [
						`if (${fast}) {`,
						`  r${instruction.dst} = MAL_VALUE_UNDEFINED;`,
						`} else {`,
						`  r${instruction.dst} = ${profileCall("property", `mal_vm_op_load_property_ic(vm, ${boxedOperand(instruction.object)}, mal_value_from_string(vm->string_constant_atoms[${relocation.stringIndex(instruction.stringIndex)}]), &${nativeBodyReference(resources, "propertyCache")}[${instruction.icIndex}])`)};`,
						`  ${throwCheck()}`,
						`}`,
					];
				}
			}
			if (
				instruction.opcode === "LOAD_PROPERTY_STATIC" &&
				nativeRegExpExecProjectionAction?.role === "caseLength"
			) {
				const { site, load } = nativeRegExpExecProjectionAction;
				if (load?.consumer?.kind === "asciiCaseLength") {
					const fast = `__regexp_exec_${site.projection.callIp}_case_${load.consumer.upperCallIp}_fast`;
					const length = `__regexp_exec_${site.projection.callIp}_case_${load.consumer.upperCallIp}_length`;
					const direct =
						reps[instruction.dst] === "number"
							? `(f64) ${length}`
							: `mal_value_from_i32((i32) ${length})`;
					return [
						`if (${fast}) {`,
						`  r${instruction.dst} = ${direct};`,
						`} else {`,
						`  r${instruction.dst} = ${profileCall("property", `mal_vm_op_load_property_ic(vm, ${boxedOperand(instruction.object)}, mal_value_from_string(vm->string_constant_atoms[${relocation.stringIndex(instruction.stringIndex)}]), &${nativeBodyReference(resources, "propertyCache")}[${instruction.icIndex}])`)};`,
						`  ${throwCheck()}`,
						`}`,
					];
				}
			}
			if (
				instruction.opcode === "LOAD_PROPERTY" &&
				nativeRegExpIteratorProjectionAction?.role === "capture"
			) {
				const { site, load } = nativeRegExpIteratorProjectionAction;
				const slot = site.loads.findIndex((entry) => entry.ip === load?.ip);
				if (slot >= 0) {
					return [
						`if (__regexp_iter_${site.projection.stepIp}_projected) {`,
						`  r${instruction.dst} = MAL_VALUE_UNDEFINED;`,
						`} else {`,
						`  r${instruction.dst} = ${profileCall("property", `mal_vm_op_load_property_ic(vm, ${boxedOperand(instruction.object)}, ${boxedOperand(instruction.key)}, &${nativeBodyReference(resources, "propertyCache")}[${instruction.icIndex}])`)};`,
						`  ${throwCheck()}`,
						`}`,
					];
				}
			}
			if (
				instruction.opcode === "LOAD_PROPERTY_STATIC" &&
				nativeRegExpExecProjectionAction?.role === "length"
			) {
				const { site, load } = nativeRegExpExecProjectionAction;
				const slot = site.loads.findIndex((entry) => entry.ip === load?.ip);
				if (slot >= 0) {
					const start = `__regexp_exec_${site.projection.callIp}_starts[${slot}]`;
					const end = `__regexp_exec_${site.projection.callIp}_ends[${slot}]`;
					const direct =
						reps[instruction.dst] === "number"
							? `(f64) (${end} - ${start})`
							: `mal_value_from_i32(${end} - ${start})`;
					return [
						`if (__regexp_exec_${site.projection.callIp}_projected && ${start} >= 0) {`,
						`  r${instruction.dst} = ${direct};`,
						`} else {`,
						`  r${instruction.dst} = ${profileCall("property", `mal_vm_op_load_property_ic(vm, ${boxedOperand(instruction.object)}, mal_value_from_string(vm->string_constant_atoms[${relocation.stringIndex(instruction.stringIndex)}]), &${nativeBodyReference(resources, "propertyCache")}[${instruction.icIndex}])`)};`,
						`  ${throwCheck()}`,
						`}`,
					];
				}
			}
			if (
				instruction.opcode === "LOAD_PROPERTY_STATIC" &&
				nativeRegExpExecProjectionAction?.role === "charCodeAtProperty"
			) {
				const { site, load } = nativeRegExpExecProjectionAction;
				const slot = site.loads.findIndex((entry) => entry.ip === load?.ip);
				if (slot >= 0 && load?.consumer?.kind === "charCodeAtZero") {
					const fast = `__regexp_exec_${site.projection.callIp}_char_${load.consumer.callIp}_fast`;
					const start = `__regexp_exec_${site.projection.callIp}_starts[${slot}]`;
					const identityCheck =
						load.consumer.methodIdentity === "authority-invariant"
							? ""
							: ` && mal_vm_local_watched_primitive_value_try_load_static(vm, __watched_methods_epoch, MAL_PRIM_KIND_STRING, &${nativeBodyReference(resources, "propertyCache")}[${instruction.icIndex}], &r${instruction.dst})`;
					return [
						`${fast} = false;`,
						`if (__regexp_exec_${site.projection.callIp}_projected && ${start} >= 0${identityCheck}) {`,
						`  ${fast} = true;`,
						`} else {`,
						`  if (__regexp_exec_${site.projection.callIp}_projected && ${start} >= 0) {`,
						`    __gc_slots[${site.slotsOffset + slot}] = ${profileCall("regexp", `mal_regexp_materialize_capture_span(vm, __gc_slots[${site.subjectSlot}], ${start}, __regexp_exec_${site.projection.callIp}_ends[${slot}])`)};`,
						`    r${instruction.object} = __gc_slots[${site.slotsOffset + slot}];`,
						`  }`,
						`  r${instruction.dst} = ${profileCall("property", `mal_vm_op_load_property_ic(vm, ${boxedOperand(instruction.object)}, mal_value_from_string(vm->string_constant_atoms[${relocation.stringIndex(instruction.stringIndex)}]), &${nativeBodyReference(resources, "propertyCache")}[${instruction.icIndex}])`)};`,
						`  ${throwCheck()}`,
						`}`,
					];
				}
			}
			if (
				instruction.opcode === "LOAD_PROPERTY" &&
				nativeRegExpExecProjectionAction?.role === "capture"
			) {
				const { site, load } = nativeRegExpExecProjectionAction;
				const slot = site.loads.findIndex((entry) => entry.ip === load?.ip);
				if (slot >= 0) {
					return [
						`if (__regexp_exec_${site.projection.callIp}_projected) {`,
						`  r${instruction.dst} = __gc_slots[${site.slotsOffset + slot}];`,
						`} else {`,
						`  r${instruction.dst} = ${profileCall("property", `mal_vm_op_load_property_ic(vm, ${boxedOperand(instruction.object)}, ${boxedOperand(instruction.key)}, &${nativeBodyReference(resources, "propertyCache")}[${instruction.icIndex}])`)};`,
						`  ${throwCheck()}`,
						`}`,
					];
				}
			}
			if (stackObjectInheritedAccess !== undefined) {
				const fallback = emitGenericInstruction();
				if (fallback === null) return null;
				return [
					`if (${stackObjectInheritedAccess.inheritedFastName}) {`,
					`  r${instruction.dst} = ${stackObjectInheritedAccess.inheritedValueName};`,
					`  mal_perf_ic_load_inherited_hit();`,
					`  mal_perf_stack_object_inherited_direct_load();`,
					`} else {`,
					...fallback.map((line) => `  ${line}`),
					`}`,
				];
			}
			if (stackObjectAccess !== undefined) {
				const { site, slot } = stackObjectAccess;
				if (site.inheritedLoadInstructionIndex === undefined) {
					return [`r${instruction.dst} = ${stackObjectSlotReference(site, slot)};`];
				}
				const fallback = emitGenericInstruction();
				if (fallback === null) return null;
				return [
					`if (${site.inheritedFastName}) {`,
					`  r${instruction.dst} = ${stackObjectSlotReference(site, slot)};`,
					`} else {`,
					...fallback.map((line) => `  ${line}`),
					`}`,
				];
			}
			const key =
				instruction.opcode === "LOAD_PROPERTY_STATIC"
					? `mal_value_from_string(vm->string_constant_atoms[${relocation.stringIndex(instruction.stringIndex)}])`
					: boxed(instruction.key);
			// Per-site monomorphic inline cache (a static, zero-initialized → starts empty).
			// A hit is a direct slot/element read with no shape search or key conversion, and
			// runs no user code. The hit writes a short-lived temp,
			// not &r${dst}: address-taking the long-lived destination register would pin it to
			// the stack across the whole function; the temp promotes back to a register once
			// the try_* helper inlines.
			const receiverName = `__property_receiver_${ip}`;
			if (instruction.opcode === "LOAD_PROPERTY") {
				const ordinary = (): Array<string> =>
					isNumericRep(reps[instruction.key]!)
						? [
								`MalArrayObject *${receiverName} = mal_vm_as_array(${boxed(instruction.object)});`,
								`MalValue __v_${ip};`,
								`if (${receiverName} && mal_vm_array_try_get_index(${receiverName}, ${num(instruction.key)}, &__v_${ip})) {`,
								`  r${instruction.dst} = __v_${ip};`,
								`} else {`,
								`  r${instruction.dst} = ${profileCall("property", `mal_vm_indexed_fast_load_index(vm, ${boxed(instruction.object)}, ${num(instruction.key)}, &${nativeBodyReference(resources, "propertyCache")}[${instruction.icIndex}])`)};`,
								`  ${throwCheck()}`,
								`}`,
							]
						: [
								`r${instruction.dst} = mal_vm_indexed_fast_load(vm, ${boxed(instruction.object)}, ${boxed(instruction.key)}, &${nativeBodyReference(resources, "propertyCache")}[${instruction.icIndex}]);`,
								throwCheck(),
							];
				if (nativeArrayPresenceProjectionAction?.role === "load") {
					const membershipIp = nativeArrayPresenceProjectionAction.membershipIp;
					const state = `__array_presence_${membershipIp}_state`;
					const fallback = emitGenericInstruction();
					if (fallback === null) return null;
					return [
						`if (${state} == 1) {`,
						`  r${instruction.dst} = ${callValue(instruction.dst, `__array_presence_${membershipIp}_value`)};`,
						`} else {`,
						...fallback.map((line) => `  ${line}`),
						`}`,
					];
				}
				if (pairedArrayLoopAction?.role === "load") {
					const { plan } = pairedArrayLoopAction;
					return [
						`if (__paired_array_${plan.id}_fast) {`,
						`  r${instruction.dst} = ${callValue(instruction.dst, `__paired_array_${plan.id}_secondary->elements[(u32) ${num(instruction.key)}]`)};`,
						`} else {`,
						...ordinary().map((line) => `  ${line}`),
						`}`,
					];
				}
				if (
					indexedLengthLoopAction?.role === "element" &&
					indexedLengthLoopAction.element?.kind === "load"
				) {
					const id = indexedLengthLoopAction.loadIp;
					const numericKeyGuard =
						indexedLengthLoopAction.site.reverseInduction !== undefined &&
						!isNumericRep(reps[instruction.key]!)
							? `mal_ops_is_number(${boxed(instruction.key)}) && `
							: "";
					const numericKey =
						indexedLengthLoopAction.site.reverseInduction !== undefined
							? `mal_ops_number_as_f64(${boxed(instruction.key)})`
							: num(instruction.key);
					const arrayLoad = indexedLengthLoopAction.element.arrayIndexIsUint32
						? `mal_vm_array_try_get_proven_index(__indexed_length_${id}_array, (u32) ${numericKey}, &__indexed_element_${ip})`
						: `mal_vm_array_try_get_index(__indexed_length_${id}_array, ${numericKey}, &__indexed_element_${ip})`;
					return [
						`MalValue __indexed_element_${ip};`,
						`if (__indexed_length_${id}_kind == 1 && ${numericKeyGuard}${arrayLoad}) {`,
						`  r${instruction.dst} = __indexed_element_${ip};`,
						`} else if (__indexed_length_${id}_kind == 2) {`,
						`  r${instruction.dst} = mal_typed_array_object_get(vm, __indexed_length_${id}_typed_array, mal_vm_typed_array_numeric_index(${numericKey}));`,
						`} else {`,
						...ordinary().map((line) => `  ${line}`),
						`}`,
					];
				}
				if (nativeStringSplitCursorAction?.role === "element") {
					const { site } = nativeStringSplitCursorAction;
					const id = site.callIp;
					const semanticValidation = site.semanticEpochStable
						? ""
						: `${semanticDependencyValidationGuard(site.cursor.license.guard, site.epochName)} && `;
					const trim = site.lockedTrimIdentity
						? [
								`  __string_split_cursor_${id}_trim_fast = ${profileCall("string", `mal_builtin_string_trim_span_direct_locked(vm, __gc_slots[${site.subjectSlot}], __string_split_cursor_${id}_start, __string_split_cursor_${id}_end, &r${instruction.dst})`)};`,
							]
						: site.trimCalleeSlot !== undefined
							? [
									`  __string_split_cursor_${id}_trim_fast = ${semanticValidation}${profileCall("string", `mal_builtin_string_trim_span_direct_licensed(vm, __gc_slots[${site.subjectSlot}], __string_split_cursor_${id}_start, __string_split_cursor_${id}_end, &r${instruction.dst})`)};`,
								]
							: [
									`  MalValue __string_split_cursor_${id}_trim_callee;`,
									`  __string_split_cursor_${id}_trim_fast = mal_vm_local_watched_primitive_value_try_load_static(vm, __watched_methods_epoch, MAL_PRIM_KIND_STRING, &${nativeBodyReference(resources, "propertyCache")}[${site.cursor.trimIcIndex}], &__string_split_cursor_${id}_trim_callee) && ${profileCall("string", `mal_builtin_string_trim_span_direct(vm, __string_split_cursor_${id}_trim_callee, __gc_slots[${site.subjectSlot}], __string_split_cursor_${id}_start, __string_split_cursor_${id}_end, &r${instruction.dst})`)};`,
								];
					return [
						`if (__string_split_cursor_${id}_active) {`,
						...trim,
						`  if (!__string_split_cursor_${id}_trim_fast) r${instruction.dst} = ${profileCall("string", `mal_builtin_string_split_cursor_materialize(vm, __gc_slots[${site.subjectSlot}], __string_split_cursor_${id}_start, __string_split_cursor_${id}_end)`)};`,
						`} else {`,
						...ordinary().map((line) => `  ${line}`),
						`}`,
					];
				}
				if (nativeStringSplitProjectionAction?.role === "element") {
					const { site, load } = nativeStringSplitProjectionAction;
					const slot = site.elementLoads.findIndex((entry) => entry.ip === load?.ip);
					if (slot >= 0) {
						return [
							`if (__string_split_${site.projection.callIp}_fast) {`,
							`  r${instruction.dst} = __gc_slots[${site.slotsOffset + slot}];`,
							`} else {`,
							...ordinary().map((line) => `  ${line}`),
							`}`,
						];
					}
				}
				return ordinary();
			}
			const probe = (): string =>
				`mal_vm_property_try_load_static(vm, ${boxed(instruction.object)}, &${nativeBodyReference(resources, "propertyCache")}[${instruction.icIndex}], &__v_${ip})`;
			const ordinary = (): Array<string> => [
				`MalObject *${receiverName} = mal_vm_as_object(${boxed(instruction.object)});`,
				`MalValue __v_${ip};`,
				`if (${probe()}) {`,
				`  r${instruction.dst} = __v_${ip};`,
				`} else {`,
				...(context.staticPropertyLoadInactiveRootMask === undefined
					? []
					: [
							`  ${cInactiveRootMaskPublication(context.staticPropertyLoadInactiveRootMask)};`,
						]),
				`  r${instruction.dst} = ${profileCall("property", `mal_vm_op_load_property_ic_static_miss(vm, ${boxed(instruction.object)}, ${key}, &${nativeBodyReference(resources, "propertyCache")}[${instruction.icIndex}])`)};`,
				`  ${throwCheck()}`,
				`}`,
			];
			if (indexedLengthLoopAction?.role === "load") {
				const id = indexedLengthLoopAction.loadIp;
				const reverse = indexedLengthLoopAction.site.reverseInduction !== undefined;
				const pairedAdmission =
					pairedArrayLoopAction?.role === "admit"
						? [
								`  __paired_array_${pairedArrayLoopAction.plan.id}_secondary = mal_vm_as_array(${boxed(pairedArrayLoopAction.plan.secondaryObject)});`,
								`  __paired_array_${pairedArrayLoopAction.plan.id}_fast = !__indexed_length_${id}_array->dense_deopted && !__indexed_length_${id}_array->dense_maybe_holey && __indexed_length_${id}_array->dense_count >= __indexed_length_${id}_value && __paired_array_${pairedArrayLoopAction.plan.id}_secondary != nullptr && !__paired_array_${pairedArrayLoopAction.plan.id}_secondary->dense_deopted && !__paired_array_${pairedArrayLoopAction.plan.id}_secondary->dense_maybe_holey && __paired_array_${pairedArrayLoopAction.plan.id}_secondary->dense_count >= __indexed_length_${id}_value && __paired_array_${pairedArrayLoopAction.plan.id}_secondary->length >= __indexed_length_${id}_value;`,
							]
						: [];
				return [
					...(pairedArrayLoopAction?.role === "admit"
						? [`__paired_array_${pairedArrayLoopAction.plan.id}_fast = false;`]
						: []),
					`__indexed_length_${id}_kind = 0;`,
					`__indexed_length_${id}_array = mal_vm_as_array(${boxed(instruction.object)});`,
					`if (__indexed_length_${id}_array != nullptr) {`,
					`  __indexed_length_${id}_kind = 1;`,
					`  __indexed_length_${id}_value = __indexed_length_${id}_array->length;`,
					`  __indexed_length_${id}_induction = (f64) __indexed_length_${id}_value;`,
					`  r${instruction.dst} = ${reps[instruction.dst] === "number" ? `__indexed_length_${id}_induction` : `mal_value_from_u32(__indexed_length_${id}_value)`};`,
					`  mal_perf_ic_load_array_length_hit();`,
					...pairedAdmission,
					`} else if (${reverse ? "false" : `mal_vm_admit_numeric_typed_array_length(vm, ${boxed(instruction.object)}, &__indexed_length_${id}_typed_array, &__indexed_length_${id}_value)`}) {`,
					`  __indexed_length_${id}_kind = 2;`,
					`  __indexed_length_${id}_induction = (f64) __indexed_length_${id}_value;`,
					`  r${instruction.dst} = ${reps[instruction.dst] === "number" ? `(f64) __indexed_length_${id}_value` : `mal_value_from_u32(__indexed_length_${id}_value)`};`,
					`} else {`,
					...ordinary().map((line) => `  ${line}`),
					`}`,
				];
			}
			if (nativeStringSplitCursorAction?.role === "length") {
				const { site } = nativeStringSplitCursorAction;
				const id = site.callIp;
				const index = isNumericRep(reps[site.cursor.index]!)
					? num(site.cursor.index)
					: `mal_ops_number_as_f64(${boxed(site.cursor.index)})`;
				const value = `${index} + (__string_split_cursor_${id}_has ? 1.0 : 0.0)`;
				return [
					`if (__string_split_cursor_${id}_active) {`,
					`  __string_split_cursor_${id}_has = ${profileCall("string", `mal_builtin_string_split_cursor_next(__gc_slots[${site.subjectSlot}], __gc_slots[${site.separatorSlot}], &__string_split_cursor_${id}_state, &__string_split_cursor_${id}_start, &__string_split_cursor_${id}_end)`)};`,
					`  r${instruction.dst} = ${reps[instruction.dst] === "number" ? value : profileCall("boxing", `mal_ops_number_value(${value})`)};`,
					`  if (!__string_split_cursor_${id}_has) { __gc_slots[${site.subjectSlot}] = MAL_VALUE_UNDEFINED; __gc_slots[${site.separatorSlot}] = MAL_VALUE_UNDEFINED; }`,
					`} else {`,
					...ordinary().map((line) => `  ${line}`),
					`}`,
				];
			}
			if (nativeStringSplitCursorAction?.role === "trimProperty") {
				const id = nativeStringSplitCursorAction.site.callIp;
				return [
					`if (__string_split_cursor_${id}_active && __string_split_cursor_${id}_trim_fast) {`,
					`  r${instruction.dst} = MAL_VALUE_UNDEFINED;`,
					`} else {`,
					...ordinary().map((line) => `  ${line}`),
					`}`,
				];
			}
			if (
				nativeStringSplitProjectionAction !== undefined &&
				nativeStringSplitProjectionAction.role !== "call"
			) {
				const { site, role, load } = nativeStringSplitProjectionAction;
				const fast = `__string_split_${site.projection.callIp}_fast`;
				if (role === "length") {
					return [
						`if (${fast}) {`,
						`  r${instruction.dst} = ${reps[instruction.dst] === "number" ? `(f64) __string_split_${site.projection.callIp}_length` : `mal_value_from_i32((i32) __string_split_${site.projection.callIp}_length)`};`,
						`} else {`,
						...ordinary().map((line) => `  ${line}`),
						`}`,
					];
				}
				const slot = site.elementLoads.findIndex((entry) => entry.ip === load?.ip);
				if (slot >= 0) {
					return [
						`if (${fast}) {`,
						`  r${instruction.dst} = __gc_slots[${site.slotsOffset + slot}];`,
						`} else {`,
						...ordinary().map((line) => `  ${line}`),
						`}`,
					];
				}
			}
			if (
				instruction.opcode === "LOAD_PROPERTY_STATIC" &&
				nativePlan?.kind === "primitive-string-length"
			) {
				const length = `mal_string_length(mal_value_to_string(${boxed(instruction.object)}))`;
				const direct = `r${instruction.dst} = ${
					reps[instruction.dst] === "number"
						? `(f64) ${length}`
						: reps[instruction.dst] === "int32"
							? `(i32) ${length}`
							: `mal_value_from_i32((i32) ${length})`
				};`;
				if (reps[instruction.object] === "string") return [direct];
				return [
					`if (mal_value_is_string(${boxed(instruction.object)})) {`,
					`  ${direct}`,
					`} else {`,
					...ordinary().map((line) => `  ${line}`),
					`}`,
				];
			}
			return ordinary();
		}
		case "STORE_PROPERTY":
		case "STORE_PROPERTY_STATIC": {
			if (stackObjectAccess !== undefined) {
				const { site, slot } = stackObjectAccess;
				return [
					`${stackObjectSlotReference(site, slot)} = ${site.scalarSlot === undefined ? boxed(instruction.value) : `r${instruction.value}`};`,
				];
			}
			if (
				instruction.opcode === "STORE_PROPERTY_STATIC" &&
				constructorInitializationAction !== undefined
			) {
				const fallback = emitGenericInstruction();
				if (fallback === null) return null;
				const { plan, index } = constructorInitializationAction;
				const fast = `__constructor_initialization_${plan.id}_fast`;
				const object = `__constructor_initialization_${plan.id}_object`;
				const cache = `&${nativeBodyReference(resources, "propertyCache")}[${instruction.icIndex}]`;
				const begin =
					index === 0
						? [
								`${object} = mal_vm_as_object(${boxed(instruction.object)});`,
								`${fast} = ${object} != nullptr && mal_vm_constructor_try_begin_initialization(${object}, (const MalInlineCache *const[]){ ${plan.stores.map((store) => `&${nativeBodyReference(resources, "propertyCache")}[${store.instruction.icIndex}]`).join(", ")} }, ${plan.stores.length});`,
							]
						: [];
				return [
					...begin,
					`if (${fast}) {`,
					`  mal_vm_constructor_initialization_store(${object}, ${cache}, ${boxed(instruction.value)});`,
					`} else {`,
					...fallback.map((line) => `  ${line}`),
					`}`,
				];
			}
			const key =
				instruction.opcode === "STORE_PROPERTY_STATIC"
					? `mal_value_from_string(vm->string_constant_atoms[${relocation.stringIndex(instruction.stringIndex)}])`
					: boxed(instruction.key);
			// See LOAD_PROPERTY: a monomorphic data-slot/dense-element hit runs no user code;
			// the general [[Set]] fallback keeps the throw check.
			const receiverName = `__property_receiver_${ip}`;
			if (instruction.opcode === "STORE_PROPERTY") {
				const ordinary = (): Array<string> =>
					isNumericRep(reps[instruction.key]!)
						? [
								`MalArrayObject *${receiverName} = mal_vm_as_array(${boxed(instruction.object)});`,
								`if (!(${receiverName} && mal_vm_array_try_store(${receiverName}, ${num(instruction.key)}, ${boxed(instruction.value)}))) {`,
								`  ${profileCall("property", `mal_vm_indexed_fast_store_index(vm, ${boxed(instruction.object)}, ${num(instruction.key)}, ${boxed(instruction.value)}, ${strict}, &${nativeBodyReference(resources, "propertyCache")}[${instruction.icIndex}])`)};`,
								`  ${throwCheck()}`,
								`}`,
							]
						: [
								`mal_vm_indexed_fast_store(vm, ${boxed(instruction.object)}, ${boxed(instruction.key)}, ${boxed(instruction.value)}, ${strict}, &${nativeBodyReference(resources, "propertyCache")}[${instruction.icIndex}]);`,
								throwCheck(),
							];
				if (
					indexedLengthLoopAction?.role === "element" &&
					indexedLengthLoopAction.element?.kind === "store"
				) {
					const id = indexedLengthLoopAction.loadIp;
					const numericKeyGuard =
						indexedLengthLoopAction.site.reverseInduction !== undefined &&
						!isNumericRep(reps[instruction.key]!)
							? `mal_ops_is_number(${boxed(instruction.key)}) && `
							: "";
					const numericKey =
						indexedLengthLoopAction.site.reverseInduction !== undefined
							? `mal_ops_number_as_f64(${boxed(instruction.key)})`
							: num(instruction.key);
					return [
						`if (__indexed_length_${id}_kind == 1 && ${numericKeyGuard}mal_vm_array_try_store(__indexed_length_${id}_array, ${numericKey}, ${boxed(instruction.value)})) {`,
						`} else if (__indexed_length_${id}_kind == 2) {`,
						`  mal_vm_numeric_typed_array_store_known_receiver(vm, __indexed_length_${id}_typed_array, ${numericKey}, ${boxed(instruction.value)}, ${strict});`,
						`  ${throwCheck()}`,
						`} else {`,
						...ordinary().map((line) => `  ${line}`),
						`}`,
					];
				}
				return ordinary();
			}
			const probe = (): string =>
				`${receiverName} && mal_vm_object_try_store_static(${receiverName}, ${boxed(instruction.value)}, &${nativeBodyReference(resources, "propertyCache")}[${instruction.icIndex}])`;
			return [
				`MalObject *${receiverName} = mal_vm_as_object(${boxed(instruction.object)});`,
				`if (!(${probe()})) {`,
				`  ${profileCall("property", `mal_vm_op_store_property_ic(vm, ${boxed(instruction.object)}, ${key}, ${boxed(instruction.value)}, ${strict}, &${nativeBodyReference(resources, "propertyCache")}[${instruction.icIndex}])`)};`,
				`  ${throwCheck()}`,
				`}`,
			];
		}
		case "TO_PROPERTY_KEY":
			if (reps[instruction.key] === "string") {
				const copy = `r${instruction.dst} = ${boxed(instruction.key)};`;
				if (reps[instruction.object] !== "boxed") return [copy];
				return [
					`if (mal_value_is_nil(${boxed(instruction.object)})) {`,
					`  r${instruction.dst} = mal_vm_op_to_property_key(vm, ${boxed(instruction.object)}, ${boxed(instruction.key)});`,
					`  ${throwCheck()}`,
					"} else {",
					`  ${copy}`,
					"}",
				];
			}
			return [
				`r${instruction.dst} = mal_vm_op_to_property_key(vm, ${boxed(instruction.object)}, ${boxed(instruction.key)});`,
				throwCheck(),
			];
		case "LOAD_GLOBAL_INDEX":
			return [
				`r${instruction.dst} = mal_value_from_i32(${relocation.globalIndex(instruction.index)});`,
			];
		case "LOAD_GLOBAL":
			return [
				`r${instruction.dst} = vm->globals[${relocation.globalIndex(instruction.index)}];`,
			];
		case "STORE_GLOBAL":
			return [
				`vm->globals[${relocation.globalIndex(instruction.index)}] = ${boxed(instruction.src)};`,
			];
		case "STORE_GLOBAL_PROPERTY":
			// A var/function declaration that becomes a property of globalThis.
			return [
				`mal_vm_op_store_global_property(vm, ${relocation.stringIndex(instruction.nameStringIndex)}, ${boxed(instruction.src)}, ${strict}, ${instruction.declaration}, ${instruction.declarationConfigurable});`,
				throwCheck(),
			];
		case "DECLARE_GLOBAL_LEXICAL":
			return [
				`mal_vm_op_declare_global_lexical(vm, ${relocation.stringIndex(instruction.nameStringIndex)}, ${relocation.globalIndex(instruction.index)}, ${instruction.immutable}, ${instruction.checkOnly});`,
				throwCheck(),
			];
		case "GLOBAL_BINDING_QUERY":
			return [
				`r${instruction.dst} = mal_vm_op_global_binding_query(vm, ${relocation.stringIndex(instruction.nameStringIndex)}, ${["typeof", "has", "delete"].indexOf(instruction.query)});`,
				throwCheck(),
			];
		case "INIT_GLOBAL_VARS":
			return [
				`mal_vm_op_init_global_vars(vm, ${instruction.nameStringIndices.length}, (const i32[]){ ${instruction.nameStringIndices.map((index) => relocation.stringIndex(index)).join(", ")} }, ${instruction.declarationConfigurable});`,
				throwCheck(),
			];
		case "CREATE_ARGUMENTS_OBJECT":
			return [
				`r${instruction.dst} = mal_create_arguments_object(vm, args, arg_count, callee, env, ${mappedArguments}, ${mappedArgumentSlots.length}, ${mappedArgumentSlots.length > 0 ? `(const i32[]){ ${mappedArgumentSlots.join(", ")} }` : "nullptr"});`,
			];
		case "LOAD_ARGUMENT_COUNT":
			if (context.directArgumentRepresentations !== undefined)
				return [
					storeNumber(
						instruction.dst,
						String(context.directArgumentRepresentations.length),
					),
				];
			return [`r${instruction.dst} = mal_value_from_i32(arg_count);`];
		case "LOAD_ARGUMENT":
			if (context.directArgumentRepresentations !== undefined) {
				const representation = context.directArgumentRepresentations[instruction.index];
				if (representation === undefined)
					throw new Error("Direct entry reads an absent argument");
				const value = `p${instruction.index}`;
				return [
					representation === "number" || representation === "int32"
						? storeNumber(instruction.dst, value)
						: representation === "boolean"
							? storeBoolean(instruction.dst, value)
							: `r${instruction.dst} = ${value};`,
				];
			}
			return [
				`r${instruction.dst} = arg_count > ${instruction.index} ? args[${instruction.index}] : MAL_VALUE_UNDEFINED;`,
			];
		case "LOAD_STATIC_ARGUMENT": {
			if (context.directArgumentRepresentations !== undefined) {
				const representation = context.directArgumentRepresentations[instruction.index];
				if (representation === undefined || instruction.direct < 0)
					throw new Error("Direct entry lacks a supplied argument snapshot");
				const value = boxed(instruction.direct);
				return [
					representation === "number" || representation === "int32"
						? storeNumber(
								instruction.dst,
								isNumericRep(reps[instruction.direct]!)
									? num(instruction.direct)
									: `mal_ops_number_as_f64(${value})`,
							)
						: representation === "boolean"
							? storeBoolean(
									instruction.dst,
									reps[instruction.direct] === "boolean"
										? `r${instruction.direct}`
										: `mal_value_to_boolean(${value})`,
								)
							: `r${instruction.dst} = ${value};`,
				];
			}
			const direct =
				instruction.direct >= 0
					? boxed(instruction.direct)
					: `args[${instruction.index}]`;
			return [
				`if (arg_count > ${instruction.index}) {`,
				`  r${instruction.dst} = ${direct};`,
				`} else {`,
				`  if (mal_value_is_undefined(r${instruction.fallback})) {`,
				`    r${instruction.fallback} = mal_create_arguments_object(vm, args, arg_count, callee, env, ${mappedArguments}, ${mappedArgumentSlots.length}, ${mappedArgumentSlots.length > 0 ? `(const i32[]){ ${mappedArgumentSlots.join(", ")} }` : "nullptr"});`,
				`  }`,
				`  r${instruction.dst} = mal_vm_op_load_property(vm, r${instruction.fallback}, mal_value_from_i32(${instruction.index}));`,
				`  ${throwCheck()}`,
				`}`,
			];
		}
		case "CREATE_REST_ARGUMENTS":
			if (nativePlan?.kind === "virtual-packed-rest-array") return [];
			if (context.directArgumentRepresentations !== undefined) return null;
			// A rest parameter `function f(...rest)`: the call arguments from
			// startIndex onward. Reads the raw args, never throws.
			return [
				`r${instruction.dst} = mal_create_rest_arguments(vm, args, arg_count, ${instruction.startIndex});`,
			];
		case "ARRAY_REST":
			// Array-destructuring rest `[a, ...rest] = src`: a null/undefined source
			// or a throwing element read propagates.
			return [
				`r${instruction.dst} = mal_array_rest(vm, ${boxed(instruction.src)}, ${instruction.startIndex});`,
				throwCheck(),
			];
		case "FOR_IN_KEYS":
			// `for (k in source)`: build the enumeration key array; a proxy trap on
			// the source can throw, so propagate.
			return [
				`r${instruction.dst} = mal_for_in_keys(vm, ${boxed(instruction.source)});`,
				throwCheck(),
			];
		case "LOAD_PRIMORDIAL":
			return [
				`r${instruction.dst} = mal_vm_load_primordial(vm, ${instruction.nodeIndex});`,
				throwCheck(),
				poll,
			];
		case "LOAD_INTRINSIC":
			return [
				`r${instruction.dst} = vm->intrinsics[${emitIntrinsic(instruction.intrinsic)}];`,
			];
		case "BINARY": {
			if (nativeArrayPresenceProjectionAction?.role === "membership") {
				const fallback = emitGenericInstruction();
				if (fallback === null) return null;
				const membershipIp = nativeArrayPresenceProjectionAction.membershipIp;
				const loadIp = nativeArrayPresenceProjectionAction.indexed.loadIp;
				const state = `__array_presence_${membershipIp}_state`;
				const probe = `${state} = __indexed_length_${loadIp}_kind == 1 ? mal_vm_array_try_get_present_proven_index(__indexed_length_${loadIp}_array, (u32) ${num(instruction.left)}, &__array_presence_${membershipIp}_value) : -1;`;
				const pairedProbe =
					pairedArrayLoopPresence === undefined
						? [probe]
						: [
								`if (__paired_array_${pairedArrayLoopPresence.id}_fast) {`,
								`  ${state} = 1;`,
								`  __array_presence_${membershipIp}_value = __indexed_length_${loadIp}_array->elements[(u32) ${num(instruction.left)}];`,
								`} else {`,
								`  ${probe}`,
								`}`,
							];
				return [
					...pairedProbe,
					`if (${state} >= 0) {`,
					reps[instruction.dst] === "boolean"
						? `  r${instruction.dst} = ${state} != 0;`
						: `  r${instruction.dst} = mal_value_new_boolean(${state} != 0);`,
					`} else {`,
					...fallback.map((line) => `  ${line}`),
					`}`,
				];
			}
			if (staticPropertyNumericAction?.role === "step") {
				const { plan, index } = staticPropertyNumericAction;
				const operand = (value: NativePropertyProjectionOperand): string => {
					switch (value.kind) {
						case "load":
							return `__property_projection_${plan.id}_value_${value.index}`;
						case "step":
							return `__property_projection_${plan.id}_step_${value.index}`;
						case "register":
							return num(value.register);
					}
				};
				const step = plan.steps[index]!;
				const expression = nativeNumberExpr(
					instruction.operator,
					operand(step.left),
					operand(step.right),
				);
				if (expression === null) return null;
				const last = index === plan.steps.length - 1;
				const startsFusion =
					last &&
					numericFusionAction?.role === "start" &&
					reps[instruction.dst] !== "number";
				const fallback = startsFusion
					? emitInstruction(
							instruction,
							ip,
							suffix,
							reps,
							strict,
							handlerIp,
							gcUnlink,
							thisSlot,
							coro,
							{ ...genericContext, numericFusionAction },
						)
					: emitGenericInstruction();
				if (fallback === null) return null;
				const result = `__property_projection_${plan.id}_step_${index}`;
				const store = startsFusion
					? `__nf_${numericFusionAction.id}_ok = true; __nf_${numericFusionAction.id}_value = ${result};`
					: reps[instruction.dst] === "number"
						? `r${instruction.dst} = ${result};`
						: reps[instruction.dst] === "int32"
							? `r${instruction.dst} = mal_ops_number_to_i32(${result});`
							: `r${instruction.dst} = ${profileCall("boxing", `mal_ops_number_value(${result})`)};`;
				return [
					`if (__property_projection_${plan.id}_fast) {`,
					`  ${result} = ${expression};`,
					...(last ? [`  ${store}`] : []),
					`} else {`,
					...fallback.map((line) => `  ${line}`),
					`}`,
				];
			}
			if (context.constantBoolean !== undefined)
				return [
					storeBoolean(instruction.dst, context.constantBoolean ? "true" : "false"),
				];
			const { dst, left, right, operator } = instruction;
			if (nativePlan?.kind === "unsigned-arithmetic") {
				const number = (register: number) =>
					isNumericRep(reps[register]!)
						? num(register)
						: `mal_ops_number_as_f64(${boxed(register)})`;
				return [
					storeNumber(
						dst,
						`(f64)((u32)(${number(left)}) ${operator} (u32)(${number(right)}))`,
					),
				];
			}
			const leftIsNum = isNumericRep(reps[left]!);
			const rightIsNum = isNumericRep(reps[right]!);
			const dstIsBool = reps[dst] === "boolean";
			const compare = NATIVE_COMPARE[operator];
			if (reps[left] === "boolean" || reps[right] === "boolean") {
				const a = coerciveNumberOperand(left),
					b = coerciveNumberOperand(right);
				if (a !== null && b !== null) {
					if (compare !== undefined && operator !== "===" && operator !== "!==")
						return [storeBoolean(dst, `${a} ${compare} ${b}`)];
					const expression =
						operator === "**"
							? `mal_number_exponentiate(${a}, ${b})`
							: nativeNumberExpr(operator, a, b);
					if (expression !== null) return [storeNumber(dst, expression)];
				}
			}
			const fusion = numericFusionAction;
			const exactInputKinds =
				nativePlan?.kind === "exact-operator-input-kinds" &&
				nativePlan.inputKindMasks.length === 2
					? nativePlan.inputKindMasks
					: undefined;
			if (
				exactInputKinds !== undefined &&
				(!leftIsNum || !rightIsNum || operator === "**") &&
				(fusion === undefined ||
					reps[fusion.role === "start" ? dst : fusion.first.dst] === "number") &&
				exactInputKinds.every((mask) =>
					compilerValueKindMaskIsSubset(mask, COMPILER_VALUE_KIND_NUMERIC_PRIMITIVE),
				)
			) {
				const a = exactPrimitiveNumber(left, exactInputKinds[0]);
				const b = exactPrimitiveNumber(right, exactInputKinds[1]);
				if (RELATIONAL_COMPARE.has(operator))
					return [storeBoolean(dst, `${a} ${compare} ${b}`)];
				const expression =
					operator === "**"
						? `mal_number_exponentiate(${a}, ${b})`
						: nativeNumberExpr(operator, a, b);
				if (expression !== null) return [storeNumber(dst, expression)];
			}
			if (indexedLengthLoopAction?.role === "compare") {
				const fallback = emitGenericInstruction();
				if (fallback === null) return null;
				const compareOperator = NATIVE_COMPARE[operator];
				if (compareOperator === undefined) return null;
				const reverse = indexedLengthLoopAction.site.reverseInduction !== undefined;
				const length = reverse
					? `__indexed_length_${indexedLengthLoopAction.loadIp}_induction`
					: `(f64) __indexed_length_${indexedLengthLoopAction.loadIp}_value`;
				const other = indexedLengthLoopAction.site.lengthPosition === 1 ? right : left;
				const otherNumber = reverse
					? `mal_ops_number_as_f64(${boxed(other)})`
					: num(other);
				const fast =
					indexedLengthLoopAction.site.lengthPosition === 1
						? `${length} ${compareOperator} ${otherNumber}`
						: `${otherNumber} ${compareOperator} ${length}`;
				return [
					`if (__indexed_length_${indexedLengthLoopAction.loadIp}_kind != 0${reverse ? ` && mal_ops_is_number(${boxed(other)})` : ""}) {`,
					dstIsBool
						? `  r${dst} = ${fast};`
						: `  r${dst} = ${profileCall("boxing", `mal_value_new_boolean(${fast})`)};`,
					`} else {`,
					...fallback.map((line) => `  ${line}`),
					`}`,
				];
			}
			if (operator === "in") {
				const membership = `__array_has_${ip}`;
				const fastMembership = `mal_vm_array_try_has(mal_vm_as_array(${boxed(right)}), ${leftIsNum ? num(left) : `mal_ops_number_as_f64(${boxed(left)})`})`;
				return [
					`i32 ${membership} = ${leftIsNum ? fastMembership : `mal_ops_is_number(${boxed(left)}) ? ${fastMembership} : -1`};`,
					`if (${membership} >= 0) {`,
					dstIsBool
						? `  r${dst} = ${membership} != 0;`
						: `  r${dst} = mal_value_new_boolean(${membership} != 0);`,
					`} else {`,
					dstIsBool
						? `  r${dst} = mal_value_to_boolean(${profileCall("binary", `mal_vm_binary_op(vm, ${emitBinaryOperator(operator)}, ${boxed(left)}, ${boxed(right)})`)});`
						: `  r${dst} = ${profileCall("binary", `mal_vm_binary_op(vm, ${emitBinaryOperator(operator)}, ${boxed(left)}, ${boxed(right)})`)};`,
					`  ${throwCheck()}`,
					`}`,
				];
			}
			if (operator === "+" && reps[left] === "string" && reps[right] === "string") {
				return [
					`r${dst} = ${profileCall("string", `mal_vm_concat_strings_known(vm, mal_value_to_string(r${left}), mal_value_to_string(r${right}))`)};`,
					throwCheck(),
				];
			}
			if (fusion?.role === "start" && reps[dst] !== "number") {
				const nativeExpr = nativeNumberExpr(
					operator,
					leftIsNum ? num(left) : `mal_ops_number_as_f64(${boxed(left)})`,
					rightIsNum ? num(right) : `mal_ops_number_as_f64(${boxed(right)})`,
				);
				if (nativeExpr !== null) {
					const guards: Array<string> = [];
					if (!leftIsNum) guards.push(`mal_ops_is_number(${boxed(left)})`);
					if (!rightIsNum) guards.push(`mal_ops_is_number(${boxed(right)})`);
					const slow = profileCall(
						"binary",
						`mal_vm_binary_op(vm, ${emitBinaryOperator(operator)}, ${boxed(left)}, ${boxed(right)})`,
					);
					return [
						`__nf_${fusion.id}_ok = ${guards.length === 0 ? "true" : guards.join(" && ")};`,
						`if (__nf_${fusion.id}_ok) {`,
						`  __nf_${fusion.id}_value = ${nativeExpr};`,
						`} else {`,
						`  r${dst} = ${slow};`,
						`  ${throwCheck()}`,
						`}`,
					];
				}
			}
			if (fusion?.role === "finish" && reps[fusion.first.dst] !== "number") {
				const first = fusion.first;
				const firstOnLeft = left === first.dst;
				const firstOnRight = right === first.dst;
				const firstLeftIsNum = isNumericRep(reps[first.left]!);
				const firstRightIsNum = isNumericRep(reps[first.right]!);
				const firstExpr = nativeNumberExpr(
					first.operator,
					firstLeftIsNum
						? num(first.left)
						: `mal_ops_number_as_f64(${boxed(first.left)})`,
					firstRightIsNum
						? num(first.right)
						: `mal_ops_number_as_f64(${boxed(first.right)})`,
				);
				if ((firstOnLeft || firstOnRight) && firstExpr !== null) {
					const external = firstOnLeft ? right : left;
					const externalIsNum = isNumericRep(reps[external]!);
					const externalExpr = externalIsNum
						? num(external)
						: `mal_ops_number_as_f64(${boxed(external)})`;
					const compare = NATIVE_COMPARE[operator];
					if (compare !== undefined) {
						const guard = externalIsNum
							? `__nf_${fusion.id}_ok`
							: `__nf_${fusion.id}_ok && mal_ops_is_number(${boxed(external)})`;
						const fast = firstOnLeft
							? `__nf_${fusion.id}_value ${compare} ${externalExpr}`
							: `${externalExpr} ${compare} __nf_${fusion.id}_value`;
						const slow = profileCall(
							"binary",
							`mal_vm_binary_op(vm, ${emitBinaryOperator(operator)}, ${boxed(left)}, ${boxed(right)})`,
						);
						return [
							`if (${guard}) {`,
							reps[dst] === "boolean"
								? `  r${dst} = ${fast};`
								: `  r${dst} = ${profileCall("boxing", `mal_value_new_boolean(${fast})`)};`,
							`} else {`,
							`  if (__nf_${fusion.id}_ok) r${first.dst} = ${profileCall("boxing", `mal_ops_number_value(__nf_${fusion.id}_value)`)};`,
							reps[dst] === "boolean"
								? `  r${dst} = mal_value_to_boolean(${slow});`
								: `  r${dst} = ${slow};`,
							...(binaryOpCanThrow(operator) ? [`  ${throwCheck()}`] : []),
							`}`,
						];
					}
					const nativeExpr = nativeNumberExpr(
						operator,
						firstOnLeft ? `__nf_${fusion.id}_value` : externalExpr,
						firstOnRight ? `__nf_${fusion.id}_value` : externalExpr,
					);
					if (nativeExpr !== null) {
						const result =
							reps[dst] === "number"
								? nativeExpr
								: reps[dst] === "int32"
									? `mal_ops_number_to_i32(${nativeExpr})`
									: profileCall("boxing", `mal_ops_number_value(${nativeExpr})`);
						const guard = externalIsNum
							? `__nf_${fusion.id}_ok`
							: `__nf_${fusion.id}_ok && mal_ops_is_number(${boxed(external)})`;
						const slow = profileCall(
							"binary",
							`mal_vm_binary_op(vm, ${emitBinaryOperator(operator)}, ${boxed(left)}, ${boxed(right)})`,
						);
						return [
							`if (${guard}) {`,
							`  r${dst} = ${result};`,
							`} else {`,
							`  if (__nf_${fusion.id}_ok) r${first.dst} = ${profileCall("boxing", `mal_ops_number_value(__nf_${fusion.id}_value)`)};`,
							`  r${dst} = ${slow};`,
							`  ${throwCheck()}`,
							`}`,
						];
					}
				}
			}
			if (
				(reps[dst] === "number" || reps[dst] === "int32") &&
				(!leftIsNum || !rightIsNum)
			) {
				const result = `__binary_result_${ip}`;
				return [
					`MalValue ${result} = ${profileCall("binary", `mal_vm_binary_op(vm, ${emitBinaryOperator(operator)}, ${boxed(left)}, ${boxed(right)})`)};`,
					throwCheck(),
					`r${dst} = ${reps[dst] === "int32" ? `mal_ops_number_to_i32(mal_ops_number_as_f64(${result}))` : `mal_ops_number_as_f64(${result})`};`,
				];
			}
			if (reps[dst] === "int32") {
				if (
					!leftIsNum ||
					!rightIsNum ||
					!["&", "|", "^", "<<", ">>"].includes(operator)
				) {
					return null;
				}
				const expr = nativeInt32Expr(
					operator,
					nativeInt32Operand(left)!,
					nativeInt32Operand(right)!,
				);
				return expr === null ? null : [`r${dst} = ${expr};`];
			}
			if (reps[dst] === "number") {
				// Bail defensively if the lattice invariant ever breaks.
				if (!leftIsNum || !rightIsNum) {
					return null;
				}
				if (dst === left && ["+", "-", "*", "/"].includes(operator)) {
					return [`r${dst} ${operator}= ${num(right)};`];
				}
				if (dst === right && (operator === "+" || operator === "*")) {
					return [`r${dst} ${operator}= ${num(left)};`];
				}
				const expr = nativeNumberExpr(operator, num(left), num(right));
				return expr === null ? null : [`r${dst} = ${expr};`];
			}
			if (operator === "**" && leftIsNum && rightIsNum) {
				return [storeNumber(dst, `mal_number_exponentiate(${num(left)}, ${num(right)})`)];
			}
			const slow = profileCall(
				"binary",
				`mal_vm_binary_op(vm, ${emitBinaryOperator(operator)}, ${boxed(left)}, ${boxed(right)})`,
			);
			const completionCheck = throwCheck();
			// Store a C bool into the dst: raw for a boolean-rep register, boxed
			// otherwise. Comparisons (and the boolean cases below) flow through here.
			const storeBool = (boolExpr: string): string =>
				dstIsBool
					? `r${dst} = ${boolExpr};`
					: `r${dst} = ${profileCall("boxing", `mal_value_new_boolean(${boolExpr})`)};`;
			// The numeric f64 of an operand: the raw double for a number-rep, else
			// recovered from its boxed form (boxing a boolean-rep first, so we never
			// feed a C bool to a MalValue helper).
			const numericOf = (r: number): string =>
				reps[r] === "int32"
					? `(f64) r${r}`
					: reps[r] === "number"
						? `r${r}`
						: `mal_ops_number_as_f64(${boxed(r)})`;
			const exactUndefined = (r: number, mask: CompilerValueKindMask): string =>
				mask === COMPILER_VALUE_KIND_UNDEFINED
					? "true"
					: mask === COMPILER_VALUE_KIND_NUMBER
						? "false"
						: `mal_value_is_undefined(${boxed(r)})`;
			const exactNumberOrUndefined = (r: number, mask: CompilerValueKindMask): string =>
				mask === COMPILER_VALUE_KIND_UNDEFINED
					? '__builtin_nan("")'
					: mask === COMPILER_VALUE_KIND_NUMBER
						? numericOf(r)
						: `(${exactUndefined(r, mask)} ? __builtin_nan("") : ${numericOf(r)})`;
			const exactNumberOrUndefinedEquality = (
				leftMask: CompilerValueKindMask,
				rightMask: CompilerValueKindMask,
			): string => {
				if (leftMask === COMPILER_VALUE_KIND_UNDEFINED) {
					return exactUndefined(right, rightMask);
				}
				if (rightMask === COMPILER_VALUE_KIND_UNDEFINED) {
					return exactUndefined(left, leftMask);
				}
				if (
					leftMask === COMPILER_VALUE_KIND_NUMBER &&
					rightMask === COMPILER_VALUE_KIND_NUMBER
				) {
					return `${numericOf(left)} == ${numericOf(right)}`;
				}
				const leftUndefined = exactUndefined(left, leftMask);
				const rightUndefined = exactUndefined(right, rightMask);
				if (leftMask === COMPILER_VALUE_KIND_NUMBER) {
					return `!(${rightUndefined}) && ${numericOf(left)} == ${numericOf(right)}`;
				}
				if (rightMask === COMPILER_VALUE_KIND_NUMBER) {
					return `!(${leftUndefined}) && ${numericOf(left)} == ${numericOf(right)}`;
				}
				return `((${leftUndefined}) && (${rightUndefined})) || (!(${leftUndefined}) && !(${rightUndefined}) && ${numericOf(left)} == ${numericOf(right)})`;
			};
			// Core has proved that each operand is either Number or undefined. This
			// closes the complete semantic domain: equality needs no coercion, while
			// relational comparison converts undefined to NaN and cannot call user
			// code or throw. Consume the proof directly instead of retaining a generic
			// fallback behind speculative number guards.
			if (
				exactInputKinds !== undefined &&
				exactInputKinds.every(
					(mask) => (mask & ~COMPILER_VALUE_KIND_NUMBER_OR_UNDEFINED) === 0,
				) &&
				compare !== undefined
			) {
				const equality = ["==", "!=", "===", "!=="].includes(operator);
				const positive = equality
					? exactNumberOrUndefinedEquality(exactInputKinds[0], exactInputKinds[1])
					: `${exactNumberOrUndefined(left, exactInputKinds[0])} ${compare} ${exactNumberOrUndefined(right, exactInputKinds[1])}`;
				const result =
					operator === "!=" || operator === "!==" ? `!(${positive})` : positive;
				return [storeBool(result)];
			}
			const guardIsNumber = (r: number): string => `mal_ops_is_number(${boxed(r)})`;
			// The speculative guard for a native numeric path: the AND of an
			// is-number test over each operand not already proven number-rep (0, 1,
			// or 2 tests). Empty when both operands are proven numbers — then the
			// native path is unconditional and the slow branch is never emitted.
			const nonNumberOperands: Array<number> = [];
			if (!leftIsNum) {
				nonNumberOperands.push(left);
			}
			if (!rightIsNum) {
				nonNumberOperands.push(right);
			}
			const numberGuard = nonNumberOperands.map(guardIsNumber).join(" && ");
			const bothBoxed = !leftIsNum && !rightIsNum;
			// Comparisons yield a boolean. The native compare over two numbers
			// never throws; the fully-general op can, though — the relational and
			// loose-equality operators run ToPrimitive (valueOf/toString) on an
			// object operand and reject a Symbol — so any path that reaches `slow`
			// propagates the completion. Strict equality never coerces, so
			// binaryOpCanThrow leaves its check off.
			if (compare !== undefined) {
				if (leftIsNum && rightIsNum) {
					return [storeBool(`${num(left)} ${compare} ${num(right)}`)];
				}
				if (
					reps[left] === "string" &&
					reps[right] === "string" &&
					RELATIONAL_COMPARE.has(operator)
				) {
					return [
						storeBool(
							`${profileCall("string", `mal_string_compare(mal_value_to_string(r${left}), mal_value_to_string(r${right}))`)} ${compare} 0`,
						),
					];
				}
				if (bothBoxed && (operator === "===" || operator === "!==")) {
					const equal = `mal_ops_strict_equal_bool(${boxed(left)}, ${boxed(right)})`;
					return [storeBool(operator === "!==" ? `!${equal}` : equal)];
				}
				const compareCheck = binaryOpCanThrow(operator) ? [completionCheck] : [];
				// Speculate a numeric compare when there is a numeric prior: always in
				// the mixed case (one operand proven number), and in the both-boxed
				// case only for the relational operators (see RELATIONAL_COMPARE).
				if (!bothBoxed || RELATIONAL_COMPARE.has(operator)) {
					const fastBool = `${numericOf(left)} ${compare} ${numericOf(right)}`;
					if (binaryOpCanThrow(operator)) {
						return [
							`if (${numberGuard}) {`,
							dstIsBool
								? `  r${dst} = ${fastBool};`
								: `  r${dst} = ${profileCall("boxing", `mal_value_new_boolean(${fastBool})`)};`,
							`} else {`,
							dstIsBool
								? `  r${dst} = mal_value_to_boolean(${slow});`
								: `  r${dst} = ${slow};`,
							`  ${completionCheck}`,
							`}`,
						];
					}
					return [
						dstIsBool
							? `r${dst} = ${numberGuard} ? (${fastBool}) : mal_value_to_boolean(${slow});`
							: `r${dst} = ${numberGuard} ? ${profileCall("boxing", `mal_value_new_boolean(${fastBool})`)} : ${slow};`,
						...compareCheck,
					];
				}
				return [
					dstIsBool ? `r${dst} = mal_value_to_boolean(${slow});` : `r${dst} = ${slow};`,
					...compareCheck,
				];
			}
			// Past here the result is boxed; a boolean-rep dst could only come from
			// a comparison (handled above), so anything else is a lattice bug.
			if (dstIsBool) {
				return null;
			}
			// Number-producing op with at least one boxed operand (both-proven-number
			// takes the number-rep path above). Speculate the boxed operand(s) are
			// numbers and take the native double op when they are, else the
			// fully-general op. `mal_ops_number_as_f64` recovers a number's exact f64
			// and `mal_ops_number_value` re-boxes with the interpreter's int32/-0/NaN
			// canonicalization, so the fast path is observably identical to the
			// fallback — including `%` (mal_number_remainder) and the bitwise/shift
			// ops (ToInt32). `+` stays correct: the guard rejects a boxed string, so
			// the string-concat branch of the slow op is only reached when the native
			// branch is not taken. This covers both the mixed and both-boxed cases;
			// for both-boxed there is no static proof, but the guard is a cheap,
			// well-predicted bit test and hot arithmetic is overwhelmingly numeric.
			if (producesNumberFromNumbers(operator)) {
				const nativeExpr = nativeNumberExpr(operator, numericOf(left), numericOf(right));
				if (nativeExpr !== null) {
					const fast = profileCall(
						"boxing",
						operator === "+" && bothBoxed
							? `mal_ops_add_numbers(${boxed(left)}, ${boxed(right)})`
							: `mal_ops_number_value(${nativeExpr})`,
					);
					// numberGuard is empty only when both operands are proven numbers but
					// the dst rep was joined to boxed elsewhere — then native is
					// unconditional and never throws.
					if (numberGuard === "") {
						return [`r${dst} = ${fast};`];
					}
					if (binaryOpCanThrow(operator)) {
						return [
							`if (${numberGuard}) {`,
							`  r${dst} = ${fast};`,
							`} else {`,
							`  r${dst} = ${slow};`,
							`  ${completionCheck}`,
							`}`,
						];
					}
					return [`r${dst} = ${numberGuard} ? ${fast} : ${slow};`];
				}
			}
			// Fully general fallback: `**`, `in`, `instanceof`, or a string/bigint
			// operand. Any non-comparison op can throw (BigInt domain errors), so
			// propagate the completion — previously only `in`/`instanceof` did, which
			// silently swallowed BigInt TypeErrors/RangeErrors here.
			const lowered = [`r${dst} = ${slow};`];
			if (binaryOpCanThrow(operator)) {
				lowered.push(completionCheck);
			}
			return lowered;
		}
		case "TYPEOF_COMPARE": {
			const { dst, src, expected, negated } = instruction;
			// Native register representations are stronger than a runtime typeof
			// query: a number-rep register can only hold a JS Number and a
			// boolean-rep register can only hold a JS Boolean. Consume that static
			// proof directly instead of boxing the scalar only to classify it again.
			// Boxed values retain the generic classifier because their precise
			// primitive/object/callable kind is not represented by this lattice yet.
			const proven = isNumericRep(reps[src]!)
				? "number"
				: reps[src] === "boolean"
					? "boolean"
					: reps[src] === "string"
						? "string"
						: undefined;
			if (proven !== undefined) {
				const value = (proven === expected) !== negated;
				return [
					reps[dst] === "boolean"
						? `r${dst} = ${value ? "true" : "false"};`
						: `r${dst} = MAL_VALUE_${value ? "TRUE" : "FALSE"};`,
				];
			}
			const predicate = `mal_vm_typeof_compare(${boxed(src)}, ${emitTypeofResult(expected)})`;
			const result = negated ? `!(${predicate})` : predicate;
			return [
				reps[dst] === "boolean"
					? `r${dst} = ${result};`
					: `r${dst} = ${profileCall("boxing", `mal_value_new_boolean(${result})`)};`,
			];
		}
		case "UNARY": {
			const { dst, src, operator } = instruction;
			if (
				indexedLengthLoopAction?.role === "coerce" ||
				indexedLengthLoopAction?.role === "update"
			) {
				const fallback = emitGenericInstruction();
				if (fallback === null) return null;
				const id = indexedLengthLoopAction.loadIp;
				const update = indexedLengthLoopAction.role === "update";
				return [
					`if (__indexed_length_${id}_kind == 1) {`,
					...(update ? [`  __indexed_length_${id}_induction -= 1.0;`] : []),
					`  ${storeNumber(dst, `__indexed_length_${id}_induction`)}`,
					`} else {`,
					...fallback.map((line) => `  ${line}`),
					`}`,
				];
			}
			if (
				operator === "tostring" &&
				(reps[src] === "boolean" ||
					(nativePlan?.kind === "exact-operator-input-kinds" &&
						nativePlan.inputKindMasks.length === 1 &&
						nativePlan.inputKindMasks[0] === COMPILER_VALUE_KIND_BOOLEAN))
			) {
				const value =
					reps[src] === "boolean" ? `r${src}` : `mal_value_to_boolean(${boxed(src)})`;
				const text = `mal_value_from_string(mal_intrinsic_hot_ascii(vm, ${value} ? MAL_HOT_KEY_TRUE : MAL_HOT_KEY_FALSE))`;
				return [`r${dst} = ${callValue(dst, text)};`, poll];
			}
			if (
				nativePlan?.kind === "exact-operator-input-kinds" &&
				nativePlan.inputKindMasks.length === 1 &&
				!isNumericRep(reps[src]!)
			) {
				const value = exactPrimitiveNumber(src, nativePlan.inputKindMasks[0]);
				const expression =
					operator === "-"
						? `-(${value})`
						: operator === "+" || operator === "tonumeric"
							? value
							: operator === "~"
								? `(f64)(~mal_ops_number_to_i32(${value}))`
								: operator === "increment" || operator === "decrement"
									? `${value} ${operator === "increment" ? "+" : "-"} 1.0`
									: null;
				if (expression !== null) return [storeNumber(dst, expression)];
			}

			if (reps[src] === "boolean") {
				const value = coerciveNumberOperand(src)!;
				const expression =
					operator === "-"
						? `-${value}`
						: operator === "+" || operator === "tonumeric"
							? value
							: operator === "~"
								? `(f64) (~(r${src} ? 1 : 0))`
								: operator === "increment" || operator === "decrement"
									? `${value} ${operator === "increment" ? "+" : "-"} 1.0`
									: null;
				if (expression !== null) return [storeNumber(dst, expression)];
			}
			if (isNumericRep(reps[src]!) && operator !== "!") {
				if (operator === "~") {
					const expression = `~${nativeInt32Operand(src)!}`;
					return [
						`r${dst} = ${reps[dst] === "int32" ? expression : reps[dst] === "number" ? `(f64) (${expression})` : `mal_value_from_i32(${expression})`};`,
					];
				}
				if (
					dst === src &&
					reps[dst] === "number" &&
					(operator === "increment" || operator === "decrement")
				) {
					return [`r${dst} ${operator === "increment" ? "+=" : "-="} 1.0;`];
				}
				const expression =
					operator === "-"
						? `-${num(src)}`
						: operator === "increment" || operator === "decrement"
							? `${num(src)} ${operator === "increment" ? "+" : "-"} 1.0`
							: operator === "+" || operator === "tonumeric"
								? num(src)
								: null;
				if (expression !== null && reps[dst] !== "boolean" && reps[dst] !== "int32")
					return [storeNumber(dst, expression)];
			}
			if (operator === "+" && reps[dst] === "number") {
				const value = `unary_number_${ip}`;
				return [
					`MalValue ${value} = mal_vm_unary_op(vm, MAL_UNARY_PLUS, ${boxed(src)});`,
					throwCheck(),
					`r${dst} = ${callValue(dst, value)};`,
				];
			}
			if (isNumericRep(reps[dst]!)) return null;
			// Logical not yields a boolean: !ToBoolean(src). This is exactly
			// mal_vm_unary_op(NOT) = mal_value_new_boolean(!mal_value_is_truthy(.)).
			if (operator === "!") {
				const negated = `!(${truthy(src)})`;
				return [
					reps[dst] === "boolean"
						? `r${dst} = ${negated};`
						: `r${dst} = ${profileCall("boxing", `mal_value_new_boolean(${negated})`)};`,
				];
			}
			// A boolean-rep dst can only come from `!` (handled above).
			if (reps[dst] === "boolean") {
				return null;
			}
			const lowered = [
				`r${dst} = ${profileCall("unary", `mal_vm_unary_op(vm, ${emitUnaryOperator(operator)}, ${boxed(src)})`)};`,
			];
			if (THROWING_UNARY_OPERATORS.has(operator)) {
				lowered.push(throwCheck());
			}
			return lowered;
		}
		case "MATH_UNARY_NUMBER": {
			const expression = nativeMathUnaryExpr(
				instruction.operation,
				typedNumber(instruction.src),
			);
			return expression === null ? null : [storeNumber(instruction.dst, expression)];
		}
		case "MATH_BINARY_NUMBER": {
			const expression = nativeMathBinaryExpr(
				instruction.operation,
				typedNumber(instruction.left),
				typedNumber(instruction.right),
			);
			return expression === null ? null : [storeNumber(instruction.dst, expression)];
		}
		case "PRECISE_NUMBER_SUM": {
			const values = instruction.arguments.map((register) =>
				isNumericRep(reps[register]!)
					? num(register)
					: `mal_ops_number_as_f64(${boxed(register)})`,
			);
			const result = `sum_result_${ip}`;
			return [
				`f64 ${result} = mal_builtin_math_sum_precise_numbers(vm, (const f64[]){ ${values.length ? values.join(", ") : "0.0"} }, ${values.length});`,
				throwCheck(),
				storeNumber(instruction.dst, result),
				poll,
			];
		}
		case "BUILTIN_ERROR":
			return [
				`r${instruction.dst} = MAL_VALUE_UNDEFINED;`,
				`mal_vm_throw_error(vm, ${knownBuiltinErrorPrototype(instruction.error)}, ${JSON.stringify(knownBuiltinErrors[instruction.error].message)});`,
				throwCheck(),
			];
		case "PREPARED_STRING_COMPARE": {
			const bytes = context.stringConstants[instruction.stringIndex]!;
			const result = `collation_result_${ip}`;
			return [
				`MalValue ${result} = mal_builtin_string_locale_compare_prepared(vm, ${boxed(instruction.left)}, ${boxed(instruction.right)}, (const byte[]){ ${bytes.length === 0 ? "0" : bytes.join(", ")} }, ${bytes.length}, ${instruction.options});`,
				throwCheck(),
				`r${instruction.dst} = ${callValue(instruction.dst, result)};`,
				poll,
			];
		}
		case "CALL_KNOWN": {
			if (!instruction.construct && instruction.argumentMode === undefined) {
				const character = STRING_CHARACTER_KERNELS[instruction.operation];
				if (character !== undefined && operandIsString(instruction.thisValue)) {
					const operand = instruction.arguments[0];
					const position =
						operand === undefined || decodeVmValueOperand(operand).kind === "undefined"
							? "0.0"
							: nativeNumberOperand(operand);
					if (position !== null) {
						const result = `character_result_${ip}`;
						return [
							`MalValue ${result} = mal_builtin_string_character_numeric(vm, mal_value_to_string(${boxedOperand(instruction.thisValue)}), ${position}, MAL_STRING_CHARACTER_${character});`,
							`r${instruction.dst} = ${callValue(instruction.dst, result)};`,
							poll,
						];
					}
				}
				if (["isNaN", "isFinite"].includes(instruction.operation)) {
					const input = instruction.arguments[0];
					const number = input === undefined ? "NAN" : nativeNumberOperand(input);
					if (number !== null)
						return [
							storeBoolean(
								instruction.dst,
								`${instruction.operation === "isNaN" ? "isnan" : "isfinite"}(${number})`,
							),
							poll,
						];
				}
				if (["BigInt.asIntN", "BigInt.asUintN"].includes(instruction.operation)) {
					const width = instruction.arguments[0];
					const bits = width === undefined ? "0.0" : nativeNumberOperand(width);
					const input = instruction.arguments[1];
					if (bits !== null) {
						const result = `bigint_width_${ip}`;
						return [
							`MalValue ${result} = mal_builtin_bigint_width_number(vm, ${bits}, ${input === undefined ? "MAL_VALUE_UNDEFINED" : boxedOperand(input)}, ${instruction.operation === "BigInt.asIntN"});`,
							throwCheck(),
							`r${instruction.dst} = ${callValue(instruction.dst, result)};`,
							poll,
						];
					}
				}
				if (instruction.operation === "BigInt.prototype.toString") {
					const input = instruction.arguments[0];
					const option =
						input === undefined
							? { kind: "undefined" as const }
							: decodeVmValueOperand(input);
					const radix =
						option.kind === "undefined"
							? 10
							: option.kind === "number"
								? Math.trunc(option.value)
								: NaN;
					if (radix >= 2 && radix <= 36) {
						const result = `bigint_text_${ip}`;
						return [
							`MalValue ${result} = mal_builtin_bigint_to_string_radix(vm, ${boxedOperand(instruction.thisValue)}, ${radix});`,
							throwCheck(),
							`r${instruction.dst} = ${callValue(instruction.dst, result)};`,
							poll,
						];
					}
				}
				if (instruction.operation === "String.prototype.charCodeAt") {
					const positionOperand = instruction.arguments[0];
					const position =
						positionOperand === undefined ? "0.0" : nativeNumberOperand(positionOperand);
					if (operandIsString(instruction.thisValue) && position !== null) {
						return [
							`r${instruction.dst} = ${profileCall("string", `mal_builtin_string_char_code_at_number(${boxedOperand(instruction.thisValue)}, ${position})`)};`,
							poll,
						];
					}
				}
				if (
					NUMBER_PREDICATES.has(instruction.operation) &&
					instruction.arguments[0] !== undefined
				) {
					const number = nativeNumberOperand(instruction.arguments[0]);
					if (number !== null) {
						const predicate =
							instruction.operation === "Number.isNaN"
								? `isnan(${number})`
								: instruction.operation === "Number.isFinite"
									? `isfinite(${number})`
									: `isfinite(${number}) && trunc(${number}) == ${number}${instruction.operation === "Number.isSafeInteger" ? ` && fabs(${number}) <= 9007199254740991.0` : ""}`;
						return [storeBoolean(instruction.dst, predicate), poll];
					}
				}
				const format = NUMBER_FORMAT_KERNELS[instruction.operation];
				if (format !== undefined) {
					const receiver = nativeNumberOperand(instruction.thisValue);
					const option =
						instruction.arguments[0] === undefined
							? { kind: "undefined" as const }
							: decodeVmValueOperand(instruction.arguments[0]);
					const digits =
						option.kind === "undefined"
							? format[3]
							: option.kind === "number" &&
								  option.value >= format[1] &&
								  option.value <= format[2]
								? option.value
								: undefined;
					if (receiver !== null && digits !== undefined)
						return [
							`r${instruction.dst} = mal_builtin_number_to_${format[0]}_numeric(vm, ${receiver}, ${digits});`,
							poll,
						];
				}
				if (
					["String.fromCharCode", "String.fromCodePoint"].includes(
						instruction.operation,
					) &&
					instruction.arguments.length <= 64
				) {
					const arguments_ = instruction.arguments.map(nativeNumberOperand);
					if (arguments_.every((argument) => argument !== null)) {
						const values =
							arguments_.length === 0
								? "nullptr"
								: `((f64[]){ ${arguments_.join(", ")} })`;
						const result = `codes_result_${ip}`;
						return [
							`MalValue ${result} = mal_builtin_string_from_codes_numbers(vm, ${values}, ${arguments_.length}, ${instruction.operation === "String.fromCodePoint" ? "true" : "false"});`,
							throwCheck(),
							`r${instruction.dst} = ${callValue(instruction.dst, result)};`,
							poll,
						];
					}
				}
				if (instruction.operation === "Math.random") {
					return [storeNumber(instruction.dst, "mal_builtin_math_random_number()"), poll];
				}
				if (instruction.operation === "Math.sumPrecise") {
					const items = instruction.arguments[0];
					const result = `sum_result_${ip}`;
					return [
						`MalValue ${result} = mal_builtin_math_sum_precise_known(vm, ${items === undefined ? "MAL_VALUE_UNDEFINED" : boxedOperand(items)});`,
						throwCheck(),
						`r${instruction.dst} = ${callValue(instruction.dst, result)};`,
						poll,
					];
				}
				const numericKernel = MATH_NUMBER_KERNELS[instruction.operation];
				if (numericKernel !== undefined) {
					const arguments_ = Array.from({ length: numericKernel[1] }, (_, index) => {
						const operand = instruction.arguments[index];
						return operand === undefined ? "NAN" : nativeNumberOperand(operand);
					});
					if (arguments_.every((argument) => argument !== null)) {
						return [
							storeNumber(
								instruction.dst,
								`${numericKernel[0]}(${arguments_.join(", ")})`,
							),
							poll,
						];
					}
				}
				if (
					["Math.min", "Math.max", "Math.hypot"].includes(instruction.operation) &&
					instruction.arguments.length <= 64
				) {
					const arguments_ = instruction.arguments.map(nativeNumberOperand);
					if (arguments_.every((argument) => argument !== null)) {
						const values =
							arguments_.length === 0
								? "nullptr"
								: `((f64[]){ ${arguments_.join(", ")} })`;
						const expression =
							instruction.operation === "Math.hypot"
								? `mal_builtin_math_hypot_numbers(${values}, ${arguments_.length})`
								: `mal_builtin_math_min_max_numbers(${values}, ${arguments_.length}, ${instruction.operation === "Math.max" ? "true" : "false"})`;
						return [storeNumber(instruction.dst, expression), poll];
					}
				}
				const arguments_ = instruction.arguments.map(nativeNumberOperand);
				const expression =
					arguments_.length >= 1 && arguments_[0] !== null
						? nativeMathUnaryExpr(instruction.operation, arguments_[0]!)
						: arguments_.length === 2 &&
							  arguments_.every((value) => value !== null) &&
							  MATH_BINARY_OPERATIONS.has(instruction.operation)
							? nativeMathBinaryExpr(
									instruction.operation,
									arguments_[0]!,
									arguments_[1]!,
								)
							: null;
				if (expression !== null) return [storeNumber(instruction.dst, expression), poll];
			}
			if (
				instruction.specialized === undefined &&
				!(
					(instruction.operation === "String.prototype.split" ||
						NUMBER_PREDICATES.has(instruction.operation)) &&
					!instruction.construct &&
					instruction.argumentMode === undefined
				)
			) {
				const args = instruction.arguments.map(boxedOperand);
				const arguments_ =
					args.length === 0 ? "nullptr" : `((MalValue[]){ ${args.join(", ")} })`;
				const value = `known_result_${ip}`;
				const fallback = [
					`MalValue ${value} = mal_vm_call_known_native(vm, ${knownNativeEntries()[knownOperationIndex(instruction.operation)!]}, ${knownOperationIndex(instruction.operation)}, ${boxedOperand(instruction.thisValue)}, ${arguments_}, ${args.length}, ${knownOperationFlags(instruction)});`,
					throwCheck(),
					`r${instruction.dst} = ${callValue(instruction.dst, value)};`,
					poll,
				];
				if (!instruction.construct && instruction.argumentMode === undefined) {
					let guard: string | undefined;
					let direct: Array<string> | undefined;
					const first = instruction.arguments[0];
					const second = instruction.arguments[1];
					if (
						["parseInt", "parseFloat"].includes(instruction.operation) &&
						first !== undefined
					) {
						const source = boxedOperand(first);
						const omittedRadix =
							instruction.operation === "parseFloat" ||
							second === undefined ||
							decodeVmValueOperand(second).kind === "undefined";
						const radix = omittedRadix ? "0.0" : nativeNumberOperand(second);
						const guards = operandIsString(first)
							? []
							: [`mal_value_is_string(${source})`];
						if (radix === null)
							guards.push(`mal_ops_is_number(${boxedOperand(second!)})`);
						const number = radix ?? `mal_ops_number_as_f64(${boxedOperand(second!)})`;
						const expression =
							instruction.operation === "parseInt"
								? `mal_builtin_parse_int_string(${source}, ${number})`
								: `mal_builtin_parse_float_string(${source})`;
						guard = guards.length === 0 ? "true" : guards.join(" && ");
						direct = [storeNumber(instruction.dst, expression), poll];
					} else if (
						["isNaN", "isFinite"].includes(instruction.operation) &&
						first !== undefined
					) {
						const input = boxedOperand(first);
						guard = `mal_ops_is_number(${input})`;
						direct = [
							storeBoolean(
								instruction.dst,
								`${instruction.operation === "isNaN" ? "isnan" : "isfinite"}(mal_ops_number_as_f64(${input}))`,
							),
							poll,
						];
					} else if (
						["BigInt.asIntN", "BigInt.asUintN"].includes(instruction.operation) &&
						first !== undefined
					) {
						const width = boxedOperand(first);
						const result = `bigint_width_${ip}`;
						guard = `mal_ops_is_number(${width})`;
						direct = [
							`MalValue ${result} = mal_builtin_bigint_width_number(vm, mal_ops_number_as_f64(${width}), ${second === undefined ? "MAL_VALUE_UNDEFINED" : boxedOperand(second)}, ${instruction.operation === "BigInt.asIntN"});`,
							throwCheck(),
							`r${instruction.dst} = ${callValue(instruction.dst, result)};`,
							poll,
						];
					} else if (
						instruction.operation === "BigInt.prototype.toString" &&
						first !== undefined
					) {
						const radix = boxedOperand(first);
						const numeric = nativeNumberOperand(first);
						const number = numeric ?? `mal_ops_number_as_f64(${radix})`;
						const result = `bigint_text_${ip}`;
						guard = `${numeric === null ? `mal_ops_is_number(${radix}) && ` : ""}${number} >= 2.0 && ${number} < 37.0`;
						direct = [
							`MalValue ${result} = mal_builtin_bigint_to_string_radix(vm, ${boxedOperand(instruction.thisValue)}, (i32) ${number});`,
							throwCheck(),
							`r${instruction.dst} = ${callValue(instruction.dst, result)};`,
							poll,
						];
					}
					if (direct !== undefined && guard !== undefined) {
						if (guard === "true") return direct;
						return [
							`if (${guard}) {`,
							...direct.map((line) => `  ${line}`),
							`} else {`,
							...fallback.map((line) => `  ${line}`),
							`}`,
						];
					}
				}
				const uri = URI_KERNELS[instruction.operation];
				if (
					uri !== undefined &&
					!instruction.construct &&
					instruction.argumentMode === undefined &&
					instruction.arguments[0] !== undefined
				) {
					const input = instruction.arguments[0];
					const value = boxedOperand(input);
					const result = `uri_result_${ip}`;
					const direct = [
						`MalValue ${result} = mal_builtin_uri_${uri[0]}_known(vm, mal_value_to_string(${value})${uri[1] === undefined ? "" : `, ${uri[1]}`});`,
						throwCheck(),
						`r${instruction.dst} = ${callValue(instruction.dst, result)};`,
						poll,
					];
					if (operandIsString(input)) return direct;
					return [
						`if (mal_value_is_string(${value})) {`,
						...direct.map((line) => `  ${line}`),
						`} else {`,
						...fallback.map((line) => `  ${line}`),
						`}`,
					];
				}
				if (
					["String.prototype.replace", "String.prototype.replaceAll"].includes(
						instruction.operation,
					) &&
					!instruction.construct &&
					instruction.argumentMode === undefined &&
					instruction.arguments[0] !== undefined
				) {
					const receiver = boxedOperand(instruction.thisValue);
					const search = boxedOperand(instruction.arguments[0]);
					const replacement = instruction.arguments[1];
					const result = `replace_result_${ip}`;
					const direct = [
						`MalValue ${result} = mal_builtin_string_replace_known(vm, mal_value_to_string(${receiver}), mal_value_to_string(${search}), ${replacement === undefined ? "MAL_VALUE_UNDEFINED" : boxedOperand(replacement)}, ${instruction.operation === "String.prototype.replaceAll"});`,
						throwCheck(),
						`r${instruction.dst} = ${callValue(instruction.dst, result)};`,
						poll,
					];
					const guards = [
						...(operandIsString(instruction.thisValue)
							? []
							: [`mal_value_is_string(${receiver})`]),
						...(operandIsString(instruction.arguments[0])
							? []
							: [`mal_value_is_string(${search})`]),
					];
					if (guards.length === 0) return direct;
					return [
						`if (${guards.join(" && ")}) {`,
						...direct.map((line) => `  ${line}`),
						`} else {`,
						...fallback.map((line) => `  ${line}`),
						`}`,
					];
				}
				if (
					!instruction.construct &&
					instruction.argumentMode === undefined &&
					instruction.operation.startsWith("String.prototype.")
				) {
					const method = instruction.operation.slice("String.prototype.".length);
					const receiver = boxedOperand(instruction.thisValue);
					const string = `mal_value_to_string(${receiver})`;
					const first = instruction.arguments[0];
					const decoded = first === undefined ? undefined : decodeVmValueOperand(first);
					const units =
						decoded?.kind === "string"
							? context.stringConstants[decoded.index]
							: undefined;
					const parameter =
						units === undefined || units.length > 16
							? undefined
							: String.fromCharCode(...units);
					const absent = decoded === undefined || decoded.kind === "undefined";
					let expression: string | undefined;
					const html = Object.hasOwn(STRING_HTML_KERNELS, method)
						? STRING_HTML_KERNELS[method]
						: undefined;
					if (html !== undefined) {
						expression = `mal_builtin_string_html_known(vm, ${string}, ${first === undefined ? "MAL_VALUE_UNDEFINED" : boxedOperand(first)}, "${html[0]}", ${html[1] === undefined ? "nullptr" : `"${html[1]}"`})`;
					} else if (
						["trim", "trimStart", "trimLeft", "trimEnd", "trimRight"].includes(method)
					) {
						expression = `mal_builtin_string_trim_known(vm, ${string}, ${method !== "trimEnd" && method !== "trimRight"}, ${method !== "trimStart" && method !== "trimLeft"})`;
					} else if (method === "isWellFormed")
						expression = `mal_builtin_string_is_well_formed_known(${string})`;
					else if (method === "toWellFormed")
						expression = `mal_builtin_string_to_well_formed_known(vm, ${string})`;
					else if (method === "normalize") {
						const form = absent ? "NFC" : parameter;
						if (form === "NFC" || form === "NFD" || form === "NFKC" || form === "NFKD")
							expression = `mal_builtin_string_normalize_known(vm, ${string}, ${form.includes("K")}, ${form.endsWith("C")})`;
					} else if (
						[
							"toUpperCase",
							"toLowerCase",
							"toLocaleUpperCase",
							"toLocaleLowerCase",
						].includes(method)
					) {
						const localized = method.includes("Locale");
						let locale: string | undefined = "MAL_UNICODE_LOCALE_ROOT";
						if (localized && !absent) {
							const selected =
								parameter === undefined ? undefined : stringCaseLocale(parameter);
							if (selected === "tr")
								locale =
									"(MAL_INTL ? MAL_UNICODE_LOCALE_TURKIC : MAL_UNICODE_LOCALE_ROOT)";
							else if (selected === "lt")
								locale =
									"(MAL_INTL ? MAL_UNICODE_LOCALE_LITHUANIAN : MAL_UNICODE_LOCALE_ROOT)";
							else if (selected === undefined) locale = undefined;
						}
						if (locale !== undefined)
							expression = `mal_builtin_string_case_known(vm, ${string}, ${method.includes("Upper")}, ${locale})`;
					}
					if (expression !== undefined) {
						const result = `string_transform_${ip}`;
						const direct = [
							`MalValue ${result} = ${expression};`,
							throwCheck(),
							`r${instruction.dst} = ${callValue(instruction.dst, result)};`,
							poll,
						];
						if (operandIsString(instruction.thisValue)) return direct;
						return [
							`if (mal_value_is_string(${receiver})) {`,
							...direct.map((line) => `  ${line}`),
							`} else {`,
							...fallback.map((line) => `  ${line}`),
							`}`,
						];
					}
				}
				if (
					instruction.operation === "String.prototype.concat" &&
					!instruction.construct &&
					instruction.argumentMode === undefined
				) {
					const result = `concat_result_${ip}`;
					return [
						`MalValue ${result};`,
						`if (mal_builtin_string_concat_direct(vm, ${boxedOperand(instruction.thisValue)}, ${arguments_}, ${args.length}, &${result})) {`,
						`  ${throwCheck()}`,
						`  r${instruction.dst} = ${callValue(instruction.dst, result)};`,
						`  ${poll}`,
						`} else {`,
						...fallback.map((line) => `  ${line}`),
						`}`,
					];
				}
				if (
					["String.prototype.padStart", "String.prototype.padEnd"].includes(
						instruction.operation,
					) &&
					!instruction.construct &&
					instruction.argumentMode === undefined
				) {
					const operand = instruction.arguments[0];
					const length =
						operand === undefined || decodeVmValueOperand(operand).kind === "undefined"
							? "0.0"
							: nativeNumberOperand(operand);
					if (length !== null) {
						const receiver = boxedOperand(instruction.thisValue);
						const fill = instruction.arguments[1];
						const result = `pad_result_${ip}`;
						const direct = [
							`MalValue ${result} = mal_builtin_string_pad_numeric(vm, mal_value_to_string(${receiver}), ${length}, ${fill === undefined ? "MAL_VALUE_UNDEFINED" : boxedOperand(fill)}, ${instruction.operation === "String.prototype.padStart" ? "true" : "false"});`,
							throwCheck(),
							`r${instruction.dst} = ${callValue(instruction.dst, result)};`,
							poll,
						];
						if (operandIsString(instruction.thisValue)) return direct;
						return [
							`if (mal_value_is_string(${receiver})) {`,
							...direct.map((line) => `  ${line}`),
							`} else {`,
							...fallback.map((line) => `  ${line}`),
							`}`,
						];
					}
				}
				const range = STRING_RANGE_KERNELS[instruction.operation];
				if (
					(range !== undefined || instruction.operation === "String.prototype.repeat") &&
					!instruction.construct &&
					instruction.argumentMode === undefined &&
					nativeStringSliceNumberFusionAction === undefined
				) {
					const position = (index: number, fallback: string) => {
						const operand = instruction.arguments[index];
						return operand === undefined ||
							decodeVmValueOperand(operand).kind === "undefined"
							? fallback
							: nativeNumberOperand(operand);
					};
					const start = position(0, "0.0");
					const end = range === undefined ? "0.0" : position(1, "INFINITY");
					if (start !== null && end !== null) {
						const receiver = boxedOperand(instruction.thisValue);
						const result = `range_result_${ip}`;
						const expression =
							range === undefined
								? `mal_builtin_string_repeat_numeric(vm, mal_value_to_string(${receiver}), ${start})`
								: `mal_builtin_string_range_numeric(vm, mal_value_to_string(${receiver}), ${start}, ${end}, MAL_STRING_RANGE_${range})`;
						const direct = [
							`MalValue ${result} = ${expression};`,
							throwCheck(),
							`r${instruction.dst} = ${callValue(instruction.dst, result)};`,
							poll,
						];
						if (operandIsString(instruction.thisValue)) return direct;
						return [
							`if (mal_value_is_string(${receiver})) {`,
							...direct.map((line) => `  ${line}`),
							`} else {`,
							...fallback.map((line) => `  ${line}`),
							`}`,
						];
					}
				}
				const search = STRING_SEARCH_KERNELS[instruction.operation];
				const character = STRING_CHARACTER_KERNELS[instruction.operation];
				if (
					character !== undefined &&
					!instruction.construct &&
					instruction.argumentMode === undefined
				) {
					const positionOperand = instruction.arguments[0];
					const position =
						positionOperand === undefined ||
						decodeVmValueOperand(positionOperand).kind === "undefined"
							? "0.0"
							: nativeNumberOperand(positionOperand);
					if (position !== null) {
						const result = `character_result_${ip}`;
						return [
							`MalValue ${result};`,
							`if (mal_builtin_string_character_direct(vm, ${boxedOperand(instruction.thisValue)}, ${position}, MAL_STRING_CHARACTER_${character}, &${result})) {`,
							`  r${instruction.dst} = ${callValue(instruction.dst, result)};`,
							`  ${poll}`,
							`} else {`,
							...fallback.map((line) => `  ${line}`),
							`}`,
						];
					}
				}
				if (
					search !== undefined &&
					!instruction.construct &&
					instruction.argumentMode === undefined &&
					instruction.arguments[0] !== undefined
				) {
					const positionOperand = instruction.arguments[1];
					const position =
						positionOperand === undefined ||
						decodeVmValueOperand(positionOperand).kind === "undefined"
							? search[1]
							: nativeNumberOperand(positionOperand);
					if (position !== null) {
						const result = `search_result_${ip}`;
						if (
							operandIsString(instruction.thisValue) &&
							operandIsString(instruction.arguments[0])
						) {
							return [
								`MalValue ${result} = mal_builtin_string_search_strings(mal_value_to_string(${boxedOperand(instruction.thisValue)}), mal_value_to_string(${boxedOperand(instruction.arguments[0])}), ${position}, MAL_STRING_SEARCH_${search[0]});`,
								`r${instruction.dst} = ${callValue(instruction.dst, result)};`,
								poll,
							];
						}

						return [
							`MalValue ${result};`,
							`if (mal_builtin_string_search_direct(${boxedOperand(instruction.thisValue)}, ${boxedOperand(instruction.arguments[0])}, ${position}, MAL_STRING_SEARCH_${search[0]}, &${result})) {`,
							`  r${instruction.dst} = ${callValue(instruction.dst, result)};`,
							`  ${poll}`,
							`} else {`,
							...fallback.map((line) => `  ${line}`),
							`}`,
						];
					}
				}
				if (nativeStringSliceNumberFusionAction !== undefined) {
					const { fusion } = nativeStringSliceNumberFusionAction;
					const fast = `__string_slice_number_${fusion.sliceCallIp}_fast`;
					const number = `__string_slice_number_${fusion.sliceCallIp}_value`;
					if (nativeStringSliceNumberFusionAction.role === "slice") {
						return [
							`${fast} = ${profileCall("string", `mal_builtin_string_slice_to_number_direct_locked(vm, ${boxedOperand(instruction.thisValue)}, ${cF64Literal(fusion.sliceStart)}, &${number})`)};`,
							`if (${fast}) {`,
							`  r${instruction.dst} = MAL_VALUE_UNDEFINED;`,
							`  ${poll}`,
							`} else {`,
							...fallback.map((line) => `  ${line}`),
							`}`,
						];
					}
					return [
						`if (${fast}) {`,
						`  r${instruction.dst} = ${reps[instruction.dst] === "number" ? number : profileCall("boxing", `mal_ops_number_value(${number})`)};`,
						`  ${poll}`,
						`} else {`,
						...fallback.map((line) => `  ${line}`),
						`}`,
					];
				}
				if (
					nativeRegExpExecProjectionAction?.role === "number" ||
					nativeRegExpIteratorProjectionAction?.role === "number"
				) {
					const exec =
						nativeRegExpExecProjectionAction?.role === "number"
							? nativeRegExpExecProjectionAction
							: undefined;
					const iterator =
						nativeRegExpIteratorProjectionAction?.role === "number"
							? nativeRegExpIteratorProjectionAction
							: undefined;
					const action = exec ?? iterator!;
					const slot = action.site.loads.findIndex(
						(entry) => entry.ip === action.load?.ip,
					);
					if (slot >= 0) {
						const prefix =
							exec === undefined
								? `__regexp_iter_${iterator!.site.projection.stepIp}`
								: `__regexp_exec_${exec.site.projection.callIp}`;
						const start = `${prefix}_starts[${slot}]`,
							end = `${prefix}_ends[${slot}]`;
						const parsed = `mal_ops_string_units_to_number(mal_string_code_units(mal_value_to_string(__gc_slots[${action.site.subjectSlot}])) + ${start}, (usize) (${end} - ${start}))`;
						return [
							`if (${prefix}_projected) {`,
							`  r${instruction.dst} = ${start} < 0 ? ${reps[instruction.dst] === "number" ? "NAN" : "mal_value_new_nan()"} : ${reps[instruction.dst] === "number" ? `mal_ops_number_as_f64(${parsed})` : parsed};`,
							`} else {`,
							...fallback.map((line) => `  ${line}`),
							`}`,
							poll,
						];
					}
				}
				if (nativeRegExpExecProjectionAction?.role === "call") {
					const { site } = nativeRegExpExecProjectionAction;
					const projection = site.projection;
					const indices = site.loads.map((load) => load.captureIndex).join(", ");
					const outputs = site.loads
						.map((_load, index) => `&__gc_slots[${site.slotsOffset + index}]`)
						.join(", ");
					const spanMask = site.loads.reduce(
						(mask, load, index) => mask | (load.consumer === undefined ? 0 : 1 << index),
						0,
					);
					const parameters = `vm, ${boxedOperand(instruction.thisValue)}, ${boxedOperand(instruction.arguments[0]!)}, (const u32[]){ ${indices} }, (MalValue *[]){ ${outputs} }, ${site.loads.length}, ${spanMask}, __regexp_exec_${projection.callIp}_starts, __regexp_exec_${projection.callIp}_ends, &__gc_slots[${site.subjectSlot}], &r${instruction.dst}`;
					if (projection.lockedFreshLiteral)
						return [
							`__regexp_exec_${projection.callIp}_projected = false;`,
							`${profileCall("regexp", `mal_regexp_exec_capture_projection_locked(${parameters})`)};`,
							throwCheck(),
							`__regexp_exec_${projection.callIp}_projected = mal_value_is_boolean(r${instruction.dst});`,
							poll,
						];
					const callee = `mal_vm_load_primordial(vm, ${knownOperations()[knownOperationIndex(instruction.operation)!]!.node})`;
					return [
						`__regexp_exec_${projection.callIp}_projected = false;`,
						`if (${profileCall("regexp", `mal_regexp_exec_capture_projection(vm, ${callee}, ${parameters.slice(4)})`)}) {`,
						`  ${throwCheck()}`,
						`  __regexp_exec_${projection.callIp}_projected = mal_value_is_boolean(r${instruction.dst});`,
						`} else {`,
						...fallback.map((line) => `  ${line}`),
						`}`,
						poll,
					];
				}
				return fallback;
			}

			const argsExpr =
				instruction.arguments.length === 0
					? "nullptr"
					: `((MalValue[]){ ${instruction.arguments.map(boxedOperand).join(", ")} })`;
			if (instruction.operation === "Array.prototype.push") {
				return [
					`r${instruction.dst} = mal_builtin_array_push_contained(vm, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${instruction.arguments.length});`,
					throwCheck(),
					poll,
				];
			}
			if (instruction.operation === "Array.prototype.pop") {
				return [
					`r${instruction.dst} = mal_builtin_array_pop_contained(vm, ${boxedOperand(instruction.thisValue)});`,
					throwCheck(),
					poll,
				];
			}
			if (instruction.operation === "Object.hasOwn") {
				return [
					`r${instruction.dst} = mal_builtin_object_has_own_known(vm, ${argsExpr}, ${instruction.arguments.length});`,
					throwCheck(),
					poll,
				];
			}
			if (instruction.operation === "Object.is") {
				const [left, right] = instruction.arguments;
				if (left !== undefined && right !== undefined) {
					const a = nativeNumberOperand(left),
						b = nativeNumberOperand(right);
					if (a !== null && b !== null) {
						const expression =
							operandRep(left) === "int32" && operandRep(right) === "int32"
								? `${a} == ${b}`
								: `(${a} == ${b} ? (${a} != 0.0 || !!signbit(${a}) == !!signbit(${b})) : (isnan(${a}) && isnan(${b})))`;
						return [storeBoolean(instruction.dst, expression)];
					}
					const aBool = nativeBooleanOperand(left),
						bBool = nativeBooleanOperand(right);
					if (aBool !== null && bBool !== null)
						return [storeBoolean(instruction.dst, `${aBool} == ${bBool}`)];
				}
				return [
					`r${instruction.dst} = mal_builtin_object_is_known(${argsExpr}, ${instruction.arguments.length});`,
				];
			}
			if (instruction.operation === "Object.keys") {
				return [
					`r${instruction.dst} = mal_builtin_object_keys_known(vm, ${argsExpr}, ${instruction.arguments.length});`,
					throwCheck(),
					poll,
				];
			}
			if (instruction.operation === "Object.values") {
				return [
					`r${instruction.dst} = mal_builtin_object_values_known(vm, ${argsExpr}, ${instruction.arguments.length});`,
					throwCheck(),
					poll,
				];
			}
			if (instruction.operation === "String.prototype.charCodeAt") {
				return [
					`r${instruction.dst} = ${profileCall("string", `mal_builtin_string_char_code_at_known(vm, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${instruction.arguments.length})`)};`,
					throwCheck(),
					poll,
				];
			}
			const collectionCall = fixedCollectionCall(
				instruction.operation,
				instruction.dst,
				instruction.thisValue,
				instruction.arguments,
			);
			if (collectionCall !== null) return [collectionCall, throwCheck(), poll];
			if (
				[
					"Number.isNaN",
					"Number.isFinite",
					"Number.isInteger",
					"Number.isSafeInteger",
				].includes(instruction.operation)
			) {
				const argument = instruction.arguments[0];
				const decoded =
					argument === undefined ? undefined : decodeVmValueOperand(argument);
				const representation = argument === undefined ? undefined : operandRep(argument);
				if (
					decoded === undefined ||
					(decoded.kind !== "register" && decoded.kind !== "number") ||
					representation === "string" ||
					representation === "boolean"
				) {
					return [storeBoolean(instruction.dst, "false")];
				}
				if (representation === "int32")
					return [
						storeBoolean(
							instruction.dst,
							instruction.operation === "Number.isNaN" ? "false" : "true",
						),
					];
				const value = nativeNumberOperand(argument!);
				if (value !== null) {
					const expression =
						instruction.operation === "Number.isNaN"
							? `isnan(${value})`
							: instruction.operation === "Number.isFinite"
								? `isfinite(${value})`
								: `isfinite(${value}) && trunc(${value}) == ${value}${instruction.operation === "Number.isSafeInteger" ? ` && fabs(${value}) <= 9007199254740991.0` : ""}`;
					return [storeBoolean(instruction.dst, expression)];
				}
			}
			if (instruction.operation === "Number.isNaN") {
				return [
					`r${instruction.dst} = mal_builtin_number_is_nan_known(${argsExpr}, ${instruction.arguments.length});`,
				];
			}
			if (instruction.operation === "Number.isFinite") {
				return [
					`r${instruction.dst} = mal_builtin_number_is_finite_known(${argsExpr}, ${instruction.arguments.length});`,
				];
			}
			if (instruction.operation === "Number.isInteger") {
				return [
					`r${instruction.dst} = mal_builtin_number_is_integer_known(${argsExpr}, ${instruction.arguments.length});`,
				];
			}
			if (instruction.operation === "Number.isSafeInteger") {
				return [
					`r${instruction.dst} = mal_builtin_number_is_safe_integer_known(${argsExpr}, ${instruction.arguments.length});`,
				];
			}
			if (instruction.operation === "Number.prototype.valueOf") {
				const value = nativeNumberOperand(instruction.thisValue);
				if (value !== null) return [storeNumber(instruction.dst, value)];
				return [
					`r${instruction.dst} = mal_builtin_number_value_of_known(${boxedOperand(instruction.thisValue)});`,
				];
			}
			if (instruction.operation === "Boolean.prototype.valueOf") {
				const value = nativeBooleanOperand(instruction.thisValue);
				if (value !== null) return [storeBoolean(instruction.dst, value)];
				return [
					`r${instruction.dst} = mal_builtin_boolean_value_of_known(${boxedOperand(instruction.thisValue)});`,
				];
			}
			if (instruction.operation === "Date.now") {
				return [`r${instruction.dst} = mal_builtin_date_now_known();`];
			}
			if (instruction.operation === "Date.parse") {
				return [
					`r${instruction.dst} = mal_builtin_date_parse_known(vm, ${argsExpr}, ${instruction.arguments.length});`,
					throwCheck(),
					poll,
				];
			}
			if (instruction.operation === "Date.UTC") {
				return [
					`r${instruction.dst} = mal_builtin_date_utc_known(vm, ${argsExpr}, ${instruction.arguments.length});`,
					throwCheck(),
					poll,
				];
			}
			if (instruction.operation !== "String.prototype.split") return null;
			if (nativeStringSplitCursorAction?.role === "call") {
				const { site } = nativeStringSplitCursorAction;
				const id = site.callIp;
				return [
					`__string_split_cursor_${id}_active = ${profileCall("string", `mal_builtin_string_split_cursor_init_locked(vm, ${boxedOperand(instruction.thisValue)}, ${boxedOperand(instruction.arguments[0]!)}, &__gc_slots[${site.subjectSlot}], &__gc_slots[${site.separatorSlot}], &__string_split_cursor_${id}_state)`)};`,
					`if (__string_split_cursor_${id}_active) {`,
					`  r${instruction.dst} = MAL_VALUE_UNDEFINED;`,
					`} else {`,
					`  r${instruction.dst} = ${profileCall("string", `mal_builtin_string_split_direct(vm, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${instruction.arguments.length})`)};`,
					`}`,
					throwCheck(),
					poll,
				];
			}
			if (nativeStringSplitProjectionAction?.role === "call") {
				const { site } = nativeStringSplitProjectionAction;
				const projection = site.projection;
				const fast = `__string_split_${projection.callIp}_fast`;
				const indices = site.elementLoads.map((load) => load.index).join(", ");
				const outputs = site.elementLoads
					.map((_load, index) => `&__gc_slots[${site.slotsOffset + index}]`)
					.join(", ");
				return [
					`${fast} = ${profileCall("string", `mal_builtin_string_split_projection_locked(vm, ${boxedOperand(instruction.thisValue)}, ${boxedOperand(instruction.arguments[0]!)}, (const u32[]){ ${indices} }, (MalValue *[]){ ${outputs} }, ${site.elementLoads.length}, &__string_split_${projection.callIp}_length)`)};`,
					`if (${fast}) {`,
					`  r${instruction.dst} = MAL_VALUE_UNDEFINED;`,
					`} else {`,
					`  r${instruction.dst} = ${profileCall("string", `mal_builtin_string_split_direct(vm, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${instruction.arguments.length})`)};`,
					`}`,
					throwCheck(),
					poll,
				];
			}
			return [
				`r${instruction.dst} = ${profileCall("string", `mal_builtin_string_split_direct(vm, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${instruction.arguments.length})`)};`,
				throwCheck(),
				poll,
			];
		}
		case "CALL": {
			const callPlan = nativePlan?.kind === "call" ? nativePlan : undefined;
			// Marshal argument registers into a temporary array (boxing numbers),
			// then dispatch through mal_vm_call_value, which handles bound, native,
			// compiled and interpreted callees and returns a completion. A throw
			// propagates via vm->completion exactly as the boxed binary ops do.
			const args = instruction.arguments;
			const argsExpr =
				args.length === 0
					? "nullptr"
					: `((MalValue[]){ ${args.map(boxedOperand).join(", ")} })`;
			const tmp = `call_result_${ip}`;
			const callResult = (value: string): string => callValue(instruction.dst, value);
			if (nativeStringCharCodeAtChainAction?.role === "call") {
				const { chain } = nativeStringCharCodeAtChainAction;
				const captured = `__string_char_code_at_${chain.callIp}_captured`;
				const boundedArgument =
					args.length === 1 ? decodeVmValueOperand(args[0]!) : undefined;
				const boundedPosition =
					callPlan?.directStringCharCodeAtPosition === "inBounds" &&
					boundedArgument?.kind === "register" &&
					isNumericRep(reps[boundedArgument.register]!)
						? num(boundedArgument.register)
						: undefined;
				if (boundedPosition !== undefined) {
					const direct = profileCall(
						"string",
						`mal_builtin_string_char_code_at_in_bounds(${boxedOperand(instruction.thisValue)}, (usize) ${boundedPosition})`,
					);
					return [
						`static MalCallCache __cc_${ip};`,
						`if (${captured}) {`,
						`  r${instruction.dst} = ${callResult(direct)};`,
						`} else {`,
						`  MAL_PERF_COUNT(string_char_code_at_direct_fallbacks);`,
						`  MalCompletion ${tmp} = ${profileCall("call", `mal_vm_call_cached(vm, &__cc_${ip}, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length})`)};`,
						`  if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow()}`,
						`  r${instruction.dst} = ${callResult(`${tmp}.value`)};`,
						`}`,
						poll,
					];
				}
				if (chain.methodIdentity === "authority-invariant") {
					const value = `string_char_code_at_${ip}_value`;
					return [
						`static MalCallCache __cc_${ip};`,
						`if (${captured}) {`,
						`  MalValue ${value} = ${profileCall("string", `mal_builtin_string_char_code_at_known(vm, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length})`)};`,
						`  ${throwCheck()}`,
						`  r${instruction.dst} = ${callResult(value)};`,
						`} else {`,
						`  MAL_PERF_COUNT(string_char_code_at_direct_fallbacks);`,
						`  MalCompletion ${tmp} = ${profileCall("call", `mal_vm_call_cached(vm, &__cc_${ip}, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length})`)};`,
						`  if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow()}`,
						`  r${instruction.dst} = ${callResult(`${tmp}.value`)};`,
						`}`,
						poll,
					];
				}
				return [
					`static MalCallCache __cc_${ip};`,
					`MalCompletion ${tmp};`,
					`if (${captured}) {`,
					`  ${tmp} = ${profileCall("string", `mal_builtin_string_char_code_at_direct(vm, &__cc_${ip}, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length})`)};`,
					`} else {`,
					`  MAL_PERF_COUNT(string_char_code_at_direct_fallbacks);`,
					`  ${tmp} = ${profileCall("call", `mal_vm_call_cached(vm, &__cc_${ip}, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length})`)};`,
					`}`,
					`if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow()}`,
					`r${instruction.dst} = ${callResult(`${tmp}.value`)};`,
					poll,
				];
			}
			if (nativeStringSplitCursorAction?.role === "call") {
				const { site, propertyLoad } = nativeStringSplitCursorAction;
				const id = site.callIp;
				const admission = regionAdmissionGuard(
					site.cursor.license,
					site.semanticEpochStable ? undefined : site.epochName,
				);
				const trimIdentity =
					site.trimCalleeSlot === undefined
						? "true"
						: `mal_vm_local_watched_primitive_value_try_load_static(vm, __watched_methods_epoch, MAL_PRIM_KIND_STRING, &${nativeBodyReference(resources, "propertyCache")}[${site.cursor.trimIcIndex}], &__gc_slots[${site.trimCalleeSlot}]) && ${profileCall("string", `mal_builtin_string_trim_identity(vm, __gc_slots[${site.trimCalleeSlot}])`)}`;
				const initialize = site.lockedIdentity
					? profileCall(
							"string",
							`mal_builtin_string_split_cursor_init_locked(vm, ${boxedOperand(instruction.thisValue)}, ${boxedOperand(instruction.arguments[0]!)}, &__gc_slots[${site.subjectSlot}], &__gc_slots[${site.separatorSlot}], &__string_split_cursor_${id}_state)`,
						)
					: `${admission} && ${trimIdentity} && ${profileCall("string", `mal_builtin_string_split_cursor_init(vm, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${boxedOperand(instruction.arguments[0]!)}, &__gc_slots[${site.subjectSlot}], &__gc_slots[${site.separatorSlot}], &__string_split_cursor_${id}_state)`)}`;
				return [
					`static MalCallCache __cc_${ip};`,
					`__string_split_cursor_${id}_active = ${initialize};`,
					`if (__string_split_cursor_${id}_active) {`,
					`  r${instruction.dst} = MAL_VALUE_UNDEFINED;`,
					`} else {`,
					...(propertyLoad === undefined
						? []
						: [
								`  r${propertyLoad.dst} = ${profileCall("property", `mal_vm_op_load_property_ic(vm, ${boxedOperand(propertyLoad.object)}, mal_value_from_string(vm->string_constant_atoms[${relocation.stringIndex(propertyLoad.stringIndex)}]), &${nativeBodyReference(resources, "propertyCache")}[${propertyLoad.icIndex}])`)};`,
								`  ${throwCheck()}`,
							]),
					`  MalCompletion ${tmp} = ${profileCall("call", `mal_vm_call_cached(vm, &__cc_${ip}, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length})`)};`,
					`  if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow()}`,
					`  r${instruction.dst} = ${tmp}.value;`,
					`}`,
					poll,
				];
			}
			if (nativeStringSplitCursorAction?.role === "trimCall") {
				const id = nativeStringSplitCursorAction.site.callIp;
				return [
					`static MalCallCache __cc_${ip};`,
					`if (__string_split_cursor_${id}_active && __string_split_cursor_${id}_trim_fast) {`,
					`  r${instruction.dst} = ${boxedOperand(instruction.thisValue)};`,
					`} else {`,
					`  MalCompletion ${tmp} = ${profileCall("call", `mal_vm_call_cached(vm, &__cc_${ip}, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length})`)};`,
					`  if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow()}`,
					`  r${instruction.dst} = ${tmp}.value;`,
					`}`,
					poll,
				];
			}
			if (
				nativeRegExpExecProjectionAction?.role === "caseUpperCall" ||
				nativeRegExpExecProjectionAction?.role === "caseLowerCall"
			) {
				const { site, load } = nativeRegExpExecProjectionAction;
				if (load?.consumer?.kind === "asciiCaseLength") {
					const fast = `__regexp_exec_${site.projection.callIp}_case_${load.consumer.upperCallIp}_fast`;
					return [
						`static MalCallCache __cc_${ip};`,
						`if (${fast}) {`,
						`  r${instruction.dst} = MAL_VALUE_UNDEFINED;`,
						`} else {`,
						`  MalCompletion ${tmp} = ${profileCall("call", `mal_vm_call_cached(vm, &__cc_${ip}, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length})`)};`,
						`  if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow()}`,
						`  r${instruction.dst} = ${tmp}.value;`,
						`}`,
						poll,
					];
				}
			}
			if (nativeRegExpIteratorProjectionAction?.role === "number") {
				const { site, load } = nativeRegExpIteratorProjectionAction;
				const slot = site.loads.findIndex((entry) => entry.ip === load?.ip);
				if (slot >= 0) {
					const start = `__regexp_iter_${site.projection.stepIp}_starts[${slot}]`;
					const end = `__regexp_iter_${site.projection.stepIp}_ends[${slot}]`;
					const parsed = `mal_ops_string_units_to_number(mal_string_code_units(mal_value_to_string(__gc_slots[${site.subjectSlot}])) + ${start}, (usize) (${end} - ${start}))`;
					const direct =
						reps[instruction.dst] === "number"
							? `mal_ops_number_as_f64(${parsed})`
							: parsed;
					return [
						`static MalCallCache __cc_${ip};`,
						`if (__regexp_iter_${site.projection.stepIp}_projected) {`,
						`  r${instruction.dst} = ${start} < 0 ? ${reps[instruction.dst] === "number" ? "NAN" : "mal_value_new_nan()"} : ${direct};`,
						`} else {`,
						`  MalCompletion ${tmp} = ${profileCall("call", `mal_vm_call_cached(vm, &__cc_${ip}, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length})`)};`,
						`  if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow()}`,
						`  r${instruction.dst} = ${reps[instruction.dst] === "number" ? `mal_ops_number_as_f64(${tmp}.value)` : `${tmp}.value`};`,
						`}`,
						poll,
					];
				}
			}
			if (nativeRegExpExecProjectionAction?.role === "number") {
				const { site, load } = nativeRegExpExecProjectionAction;
				const slot = site.loads.findIndex((entry) => entry.ip === load?.ip);
				if (slot >= 0) {
					const start = `__regexp_exec_${site.projection.callIp}_starts[${slot}]`;
					const end = `__regexp_exec_${site.projection.callIp}_ends[${slot}]`;
					const parsed = `mal_ops_string_units_to_number(mal_string_code_units(mal_value_to_string(__gc_slots[${site.subjectSlot}])) + ${start}, (usize) (${end} - ${start}))`;
					const direct =
						reps[instruction.dst] === "number"
							? `mal_ops_number_as_f64(${parsed})`
							: parsed;
					return [
						`static MalCallCache __cc_${ip};`,
						`if (__regexp_exec_${site.projection.callIp}_projected) {`,
						`  r${instruction.dst} = ${start} < 0 ? ${reps[instruction.dst] === "number" ? "NAN" : "mal_value_new_nan()"} : ${direct};`,
						`} else {`,
						`  MalCompletion ${tmp} = ${profileCall("call", `mal_vm_call_cached(vm, &__cc_${ip}, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length})`)};`,
						`  if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow()}`,
						`  r${instruction.dst} = ${reps[instruction.dst] === "number" ? `mal_ops_number_as_f64(${tmp}.value)` : `${tmp}.value`};`,
						`}`,
						poll,
					];
				}
			}
			if (nativeRegExpExecProjectionAction?.role === "charCodeAtCall") {
				const { site, load } = nativeRegExpExecProjectionAction;
				const slot = site.loads.findIndex((entry) => entry.ip === load?.ip);
				if (slot >= 0 && load?.consumer?.kind === "charCodeAtZero") {
					const fast = `__regexp_exec_${site.projection.callIp}_char_${ip}_fast`;
					const start = `__regexp_exec_${site.projection.callIp}_starts[${slot}]`;
					const end = `__regexp_exec_${site.projection.callIp}_ends[${slot}]`;
					const codeUnit = `mal_string_code_units(mal_value_to_string(__gc_slots[${site.subjectSlot}]))[${start}]`;
					const value =
						reps[instruction.dst] === "number"
							? `(f64) ${codeUnit}`
							: reps[instruction.dst] === "int32"
								? `(i32) ${codeUnit}`
								: `mal_value_from_i32(${codeUnit})`;
					const empty =
						reps[instruction.dst] === "number"
							? "NAN"
							: reps[instruction.dst] === "int32"
								? "0"
								: "mal_value_new_nan()";
					const direct = `(${end} > ${start} ? ${value} : ${empty})`;
					return [
						`static MalCallCache __cc_${ip};`,
						`if (${fast}) {`,
						`  r${instruction.dst} = ${direct};`,
						`} else {`,
						`  MalCompletion ${tmp} = ${profileCall("string", `mal_builtin_string_char_code_at_direct(vm, &__cc_${ip}, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length})`)};`,
						`  if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow()}`,
						`  r${instruction.dst} = ${callResult(`${tmp}.value`)};`,
						`}`,
						poll,
					];
				}
			}
			if (nativeRegExpExecProjectionAction?.role === "call") {
				const { site, propertyLoad } = nativeRegExpExecProjectionAction;
				const projection = site.projection;
				const fast = `__regexp_exec_${projection.callIp}_fast`;
				const indices = site.loads.map((load) => load.captureIndex).join(", ");
				const outputs = site.loads
					.map((_load, index) => `&__gc_slots[${site.slotsOffset + index}]`)
					.join(", ");
				const spanMask = site.loads.reduce(
					(mask, load, index) => mask | (load.consumer === undefined ? 0 : 1 << index),
					0,
				);
				if (propertyLoad !== undefined) {
					return [
						`__regexp_exec_${projection.callIp}_projected = false;`,
						`${profileCall("regexp", `mal_regexp_exec_capture_projection_locked(vm, ${boxedOperand(instruction.thisValue)}, ${boxedOperand(instruction.arguments[0]!)}, (const u32[]){ ${indices} }, (MalValue *[]){ ${outputs} }, ${site.loads.length}, ${spanMask}, __regexp_exec_${projection.callIp}_starts, __regexp_exec_${projection.callIp}_ends, &__gc_slots[${site.subjectSlot}], &r${instruction.dst})`)};`,
						throwCheck(),
						`__regexp_exec_${projection.callIp}_projected = mal_value_is_boolean(r${instruction.dst});`,
						poll,
					];
				}
				const project = profileCall(
					"regexp",
					`mal_regexp_exec_capture_projection(vm, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${boxedOperand(instruction.arguments[0]!)}, (const u32[]){ ${indices} }, (MalValue *[]){ ${outputs} }, ${site.loads.length}, ${spanMask}, __regexp_exec_${projection.callIp}_starts, __regexp_exec_${projection.callIp}_ends, &__gc_slots[${site.subjectSlot}], &r${instruction.dst})`,
				);
				return [
					`static MalCallCache __cc_${ip};`,
					`__regexp_exec_${projection.callIp}_projected = false;`,
					`${fast} = ${project};`,
					`if (${fast}) {`,
					`  ${throwCheck()}`,
					`  __regexp_exec_${projection.callIp}_projected = mal_value_is_boolean(r${instruction.dst});`,
					`} else {`,
					`  MalCompletion ${tmp} = ${profileCall("call", `mal_vm_call_cached(vm, &__cc_${ip}, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length})`)};`,
					`  if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow()}`,
					`  r${instruction.dst} = ${tmp}.value;`,
					`}`,
					poll,
				];
			}
			if (nativeStringSliceNumberFusionAction !== undefined) {
				const { fusion, lockedIdentity, propertyLoad } =
					nativeStringSliceNumberFusionAction;
				const fast = `__string_slice_number_${fusion.sliceCallIp}_fast`;
				const value = `__string_slice_number_${fusion.sliceCallIp}_value`;
				if (nativeStringSliceNumberFusionAction.role === "slice") {
					const convert = lockedIdentity
						? profileCall(
								"string",
								`mal_builtin_string_slice_to_number_direct_locked(vm, ${boxedOperand(instruction.thisValue)}, ${cF64Literal(fusion.sliceStart)}, &${value})`,
							)
						: profileCall(
								"string",
								`mal_builtin_string_slice_to_number_direct(vm, ${boxedOperand(instruction.callee)}, ${boxed(fusion.numberCallee)}, ${boxedOperand(instruction.thisValue)}, ${cF64Literal(fusion.sliceStart)}, &${value})`,
							);
					return [
						`static MalCallCache __cc_${ip};`,
						`${fast} = ${convert};`,
						`if (${fast}) {`,
						`  r${instruction.dst} = MAL_VALUE_UNDEFINED;`,
						`  ${poll}`,
						`} else {`,
						...(propertyLoad === undefined
							? []
							: [
									`  r${propertyLoad.dst} = ${profileCall("property", `mal_vm_op_load_property_ic(vm, ${boxedOperand(propertyLoad.object)}, mal_value_from_string(vm->string_constant_atoms[${relocation.stringIndex(propertyLoad.stringIndex)}]), &${nativeBodyReference(resources, "propertyCache")}[${propertyLoad.icIndex}])`)};`,
									`  ${throwCheck()}`,
								]),
						`  MalCompletion ${tmp} = ${profileCall("call", `mal_vm_call_cached(vm, &__cc_${ip}, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length})`)};`,
						`  if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow()}`,
						`  r${instruction.dst} = ${tmp}.value;`,
						`  ${poll}`,
						`}`,
					];
				}
				return [
					`static MalCallCache __cc_${ip};`,
					`if (${fast}) {`,
					`  r${instruction.dst} = ${reps[instruction.dst] === "number" ? value : profileCall("boxing", `mal_ops_number_value(${value})`)};`,
					`  ${poll}`,
					`} else {`,
					`  MalCompletion ${tmp} = ${profileCall("call", `mal_vm_call_cached(vm, &__cc_${ip}, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length})`)};`,
					`  if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow()}`,
					`  r${instruction.dst} = ${reps[instruction.dst] === "number" ? `mal_ops_number_as_f64(${tmp}.value)` : `${tmp}.value`};`,
					`  ${poll}`,
					`}`,
				];
			}
			if (nativeStringSplitProjectionAction?.role === "call") {
				const { site, propertyLoad } = nativeStringSplitProjectionAction;
				const projection = site.projection;
				const fast = `__string_split_${projection.callIp}_fast`;
				const indices = site.elementLoads.map((load) => load.index).join(", ");
				const outputs = site.elementLoads
					.map((_load, index) => `&__gc_slots[${site.slotsOffset + index}]`)
					.join(", ");
				const project = site.lockedIdentity
					? profileCall(
							"string",
							`mal_builtin_string_split_projection_locked(vm, ${boxedOperand(instruction.thisValue)}, ${boxedOperand(instruction.arguments[0]!)}, (const u32[]){ ${indices} }, (MalValue *[]){ ${outputs} }, ${site.elementLoads.length}, &__string_split_${projection.callIp}_length)`,
						)
					: profileCall(
							"string",
							`mal_builtin_string_split_projection(vm, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${boxedOperand(instruction.arguments[0]!)}, (const u32[]){ ${indices} }, (MalValue *[]){ ${outputs} }, ${site.elementLoads.length}, &__string_split_${projection.callIp}_length)`,
						);
				return [
					`static MalCallCache __cc_${ip};`,
					`${fast} = ${project};`,
					`if (${fast}) {`,
					`  r${instruction.dst} = MAL_VALUE_UNDEFINED;`,
					`  ${poll}`,
					`} else {`,
					...(propertyLoad === undefined
						? []
						: [
								`  r${propertyLoad.dst} = ${profileCall("property", `mal_vm_op_load_property_ic(vm, ${boxedOperand(propertyLoad.object)}, mal_value_from_string(vm->string_constant_atoms[${relocation.stringIndex(propertyLoad.stringIndex)}]), &${nativeBodyReference(resources, "propertyCache")}[${propertyLoad.icIndex}])`)};`,
								`  ${throwCheck()}`,
							]),
					`  MalCompletion ${tmp} = ${profileCall("call", `mal_vm_call_cached(vm, &__cc_${ip}, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length})`)};`,
					`  if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow()}`,
					`  r${instruction.dst} = ${tmp}.value;`,
					`  ${poll}`,
					`}`,
				];
			}
			const numericCallback = callPlan?.numericSortCallback;
			if (
				numericCallback !== undefined &&
				args.length === (numericCallback.viaCall ? 2 : 1)
			) {
				const entry = directCompiledEntries.get(
					directCompiledEntryKey(numericCallback.functionIndex, numericCallback.entryId),
				);
				if (
					entry !== undefined &&
					entry.parameterRepresentations.length === 2 &&
					entry.parameterRepresentations.every((rep) => rep === "number") &&
					entry.resultRepresentation === "number" &&
					entry.argumentRepresentations === undefined &&
					entry.fieldParameters === undefined
				) {
					return [
						`static MalCallCache __cc_${ip};`,
						`MalCompletion ${tmp} = mal_builtin_sort_numeric(vm, &__cc_${ip}, ${numericCallback.operation === "toSorted" ? "true" : "false"}, ${numericCallback.viaCall ? "true" : "false"}, ${relocation.functionIndex(numericCallback.functionIndex)}, mal_direct_${numericCallback.functionIndex}_${numericCallback.entryId}${suffix}, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length});`,
						`if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow()}`,
						`r${instruction.dst} = ${callResult(`${tmp}.value`)};`,
						poll,
					];
				}
			}
			const guardedBuiltinOperation = callPlan?.guardedBuiltinCall?.operation;
			if (
				guardedBuiltinOperation === "Boolean" ||
				guardedBuiltinOperation === "Boolean.prototype.valueOf" ||
				guardedBuiltinOperation === "Boolean.prototype.toString"
			) {
				const operation = {
					Boolean: "MAL_BOOLEAN_CALL",
					"Boolean.prototype.valueOf": "MAL_BOOLEAN_VALUE_OF",
					"Boolean.prototype.toString": "MAL_BOOLEAN_TO_STRING",
				}[guardedBuiltinOperation];
				const receiver = boxedOperand(instruction.thisValue);
				const argument =
					args.length === 0 ? "MAL_VALUE_UNDEFINED" : boxedOperand(args[0]!);
				const primitiveReceiver = nativeBooleanOperand(instruction.thisValue);
				const receiverGuard =
					operation === "MAL_BOOLEAN_CALL" || primitiveReceiver !== null
						? ""
						: ` && mal_value_is_boolean(${receiver})`;
				const boolean = primitiveReceiver ?? `mal_value_to_boolean(${receiver})`;
				const result =
					operation === "MAL_BOOLEAN_CALL"
						? storeBoolean(instruction.dst, `mal_value_is_truthy(${argument})`)
						: operation === "MAL_BOOLEAN_VALUE_OF"
							? storeBoolean(instruction.dst, boolean)
							: `r${instruction.dst} = ${callResult(`mal_value_from_string(mal_intrinsic_hot_ascii(vm, ${boolean} ? MAL_HOT_KEY_TRUE : MAL_HOT_KEY_FALSE))`)};`;
				return [
					`if (mal_builtin_boolean_callee_matches(${operation}, ${boxedOperand(instruction.callee)})${receiverGuard}) {`,
					result,
					`} else {`,
					`static MalCallCache __cc_${ip};`,
					`MalCompletion ${tmp} = mal_vm_call_cached(vm, &__cc_${ip}, ${boxedOperand(instruction.callee)}, ${receiver}, ${argsExpr}, ${args.length});`,
					`if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow()}`,
					`r${instruction.dst} = ${callResult(`${tmp}.value`)};`,
					`}`,
					poll,
				];
			}
			const numberPredicate = NUMBER_PREDICATES.get(guardedBuiltinOperation ?? "");
			if (numberPredicate !== undefined) {
				const argument = args[0];
				const number = argument === undefined ? null : nativeNumberOperand(argument);
				const test =
					argument === undefined
						? "false"
						: number === null
							? `mal_builtin_number_value_${numberPredicate.slice("MAL_NUMBER_PREDICATE_".length).toLowerCase()}(${boxedOperand(argument)})`
							: guardedBuiltinOperation === "Number.isNaN"
								? `isnan(${number})`
								: guardedBuiltinOperation === "Number.isFinite"
									? `isfinite(${number})`
									: `isfinite(${number}) && trunc(${number}) == ${number}${guardedBuiltinOperation === "Number.isSafeInteger" ? ` && fabs(${number}) <= 9007199254740991.0` : ""}`;
				return [
					`if (mal_builtin_number_predicate_callee_matches(${numberPredicate}, ${boxedOperand(instruction.callee)})) {`,
					storeBoolean(instruction.dst, test),
					`} else {`,
					`static MalCallCache __cc_${ip};`,
					`MalCompletion ${tmp} = mal_vm_call_cached(vm, &__cc_${ip}, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length});`,
					`if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow()}`,
					`r${instruction.dst} = ${callResult(`${tmp}.value`)};`,
					`}`,
					poll,
				];
			}
			if (
				guardedBuiltinOperation === "Number.prototype.toFixed" ||
				guardedBuiltinOperation === "Number.prototype.toExponential" ||
				guardedBuiltinOperation === "Number.prototype.toPrecision"
			) {
				const method = {
					"Number.prototype.toFixed": "MAL_NUMBER_FORMAT_FIXED",
					"Number.prototype.toExponential": "MAL_NUMBER_FORMAT_EXPONENTIAL",
					"Number.prototype.toPrecision": "MAL_NUMBER_FORMAT_PRECISION",
				}[guardedBuiltinOperation];
				const option = args.length === 0 ? "MAL_VALUE_UNDEFINED" : boxedOperand(args[0]!);
				const format = NUMBER_FORMAT_KERNELS[guardedBuiltinOperation]!;
				const constant =
					args.length === 0
						? { kind: "undefined" as const }
						: decodeVmValueOperand(args[0]!);
				const digits =
					constant.kind === "undefined"
						? format[3]
						: constant.kind === "number" &&
							  Number.isInteger(constant.value) &&
							  constant.value >= format[1] &&
							  constant.value <= format[2]
							? constant.value
							: undefined;
				const receiver = boxedOperand(instruction.thisValue);
				const guard =
					digits === undefined
						? `mal_builtin_number_format_try_direct(vm, ${method}, ${boxedOperand(instruction.callee)}, ${receiver}, ${option}, &__number_format_${ip})`
						: `mal_builtin_number_format_callee_matches(vm, ${method}, ${boxedOperand(instruction.callee)})`;
				return [
					...(digits === undefined ? [`MalValue __number_format_${ip};`] : []),
					`if (mal_ops_is_number(${receiver}) && ${guard}) {`,
					...(digits === undefined
						? []
						: [
								`MalValue __number_format_${ip} = mal_builtin_number_to_${format[0]}_numeric(vm, mal_ops_number_as_f64(${receiver}), ${digits});`,
							]),
					throwCheck(),
					`r${instruction.dst} = __number_format_${ip};`,
					`} else {`,
					`static MalCallCache __cc_${ip};`,
					`MalCompletion ${tmp} = mal_vm_call_cached(vm, &__cc_${ip}, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length});`,
					`if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow()}`,
					`r${instruction.dst} = ${tmp}.value;`,
					`}`,
					poll,
				];
			}
			if (
				nativeBuiltinCollectionCallChainAction?.role === "call" &&
				nativeBuiltinCollectionCallChainAction.chain.license.guard.dependencies.length ===
					1 &&
				nativeBuiltinCollectionCallChainAction.chain.license.guard.dependencies[0]
					?.kind === "world" &&
				nativeBuiltinCollectionCallChainAction.chain.license.guard.dependencies[0]
					.fact === "primordials.locked" &&
				((nativeBuiltinCollectionCallChainAction.chain.operation.startsWith("Map.") &&
					callPlan?.exactCollectionReceiver === "Map") ||
					(nativeBuiltinCollectionCallChainAction.chain.operation.startsWith("Set.") &&
						callPlan?.exactCollectionReceiver === "Set"))
			) {
				const operation = nativeBuiltinCollectionCallChainAction.chain.operation;
				return [
					fixedCollectionCall(operation, instruction.dst, instruction.thisValue, args)!,
					throwCheck(),
					...(operation === "Map.prototype.set" || operation === "Set.prototype.add"
						? [poll]
						: []),
				];
			}
			const arrayIterationOperation =
				guardedBuiltinOperation === undefined
					? undefined
					: {
							"Array.prototype.forEach": "MAL_BUILTIN_ARRAY_ITERATION_FOR_EACH",
							"Array.prototype.some": "MAL_BUILTIN_ARRAY_ITERATION_SOME",
							"Array.prototype.every": "MAL_BUILTIN_ARRAY_ITERATION_EVERY",
							"Array.prototype.find": "MAL_BUILTIN_ARRAY_ITERATION_FIND",
							"Array.prototype.findIndex": "MAL_BUILTIN_ARRAY_ITERATION_FIND_INDEX",
							"Array.prototype.map": "MAL_BUILTIN_ARRAY_ITERATION_MAP",
							"Array.prototype.filter": "MAL_BUILTIN_ARRAY_ITERATION_FILTER",
							"Array.prototype.reduce": "MAL_BUILTIN_ARRAY_ITERATION_REDUCE",
							"Array.prototype.reduceRight": "MAL_BUILTIN_ARRAY_ITERATION_REDUCE_RIGHT",
							"Array.prototype.findLast": "MAL_BUILTIN_ARRAY_ITERATION_FIND_LAST",
							"Array.prototype.findLastIndex":
								"MAL_BUILTIN_ARRAY_ITERATION_FIND_LAST_INDEX",
							"Array.prototype.flatMap": "MAL_BUILTIN_ARRAY_ITERATION_FLAT_MAP",
						}[
							guardedBuiltinOperation as
								| "Array.prototype.forEach"
								| "Array.prototype.some"
								| "Array.prototype.every"
								| "Array.prototype.find"
								| "Array.prototype.findIndex"
								| "Array.prototype.map"
								| "Array.prototype.filter"
								| "Array.prototype.reduce"
								| "Array.prototype.reduceRight"
								| "Array.prototype.findLast"
								| "Array.prototype.findLastIndex"
								| "Array.prototype.flatMap"
						];
			if (arrayIterationOperation !== undefined) {
				nativeCallDecision(
					context.profile,
					ip,
					"call.builtin-direct",
					"retained",
					"runtime-helper-owned-dispatch",
				);
				const callbackTarget = callPlan?.directCallbackFunctionIndex;
				const callbackSymbol =
					callbackTarget !== undefined && directCompiledTargets.has(callbackTarget)
						? `mal_compiled_${callbackTarget}${suffix}`
						: "nullptr";
				return [
					`static MalCallCache __cc_${ip};`,
					`MalCompletion ${tmp} = mal_builtin_array_iteration_direct(vm, &__cc_${ip}, ${arrayIterationOperation}, ${callPlan?.directCallbackFunctionIndex === undefined ? -1 : relocation.functionIndex(callPlan.directCallbackFunctionIndex)}, ${callbackSymbol}, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length});`,
					`if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow()}`,
					`r${instruction.dst} = ${callResult(`${tmp}.value`)};`,
					poll,
				];
			}
			if (
				guardedBuiltinOperation === "Map.prototype.get" ||
				guardedBuiltinOperation === "Map.prototype.set" ||
				guardedBuiltinOperation === "Map.prototype.has" ||
				guardedBuiltinOperation === "Map.prototype.delete" ||
				guardedBuiltinOperation === "Set.prototype.add" ||
				guardedBuiltinOperation === "Set.prototype.has" ||
				guardedBuiltinOperation === "Set.prototype.delete"
			) {
				const operation = nativeBuiltinCollectionOperation(guardedBuiltinOperation);
				const receiverFact =
					callPlan?.exactCollectionReceiver === "Map"
						? "MAL_BUILTIN_COLLECTION_RECEIVER_EXACT_MAP"
						: callPlan?.exactCollectionReceiver === "Set"
							? "MAL_BUILTIN_COLLECTION_RECEIVER_EXACT_SET"
							: "MAL_BUILTIN_COLLECTION_RECEIVER_UNKNOWN";
				return [
					`static MalCallCache __cc_${ip};`,
					`MalCompletion ${tmp} = mal_builtin_collection_direct(vm, &__cc_${ip}, ${operation}, ${receiverFact}, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length});`,
					`if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow()}`,
					`r${instruction.dst} = ${tmp}.value;`,
					poll,
				];
			}
			if (vmCallProvesBuiltin(callPlan, "Array.prototype.push")) {
				return [
					`static MalCallCache __cc_${ip};`,
					`MalCompletion ${tmp} = mal_builtin_array_push_direct(vm, &__cc_${ip}, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length}, nullptr);`,
					`if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow()}`,
					`r${instruction.dst} = ${tmp}.value;`,
					poll,
				];
			}
			if (vmCallProvesBuiltin(callPlan, "Array.prototype.at")) {
				return [
					`static MalCallCache __cc_${ip};`,
					`MalCompletion ${tmp} = mal_builtin_array_at_direct(vm, &__cc_${ip}, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length});`,
					`if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow()}`,
					`r${instruction.dst} = ${tmp}.value;`,
					poll,
				];
			}
			if (vmCallProvesBuiltin(callPlan, "String.prototype.charCodeAt")) {
				const boundedArgument =
					args.length === 1 ? decodeVmValueOperand(args[0]!) : undefined;
				const boundedPosition =
					callPlan?.directStringCharCodeAtPosition === "inBounds" &&
					boundedArgument?.kind === "register" &&
					isNumericRep(reps[boundedArgument.register]!)
						? num(boundedArgument.register)
						: null;
				if (boundedPosition !== null) {
					return [
						`static MalCallCache __cc_${ip};`,
						`MalCompletion ${tmp} = ${profileCall("string", `mal_builtin_string_char_code_at_direct_in_bounds(vm, &__cc_${ip}, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length}, ${boundedPosition})`)};`,
						`if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow()}`,
						`r${instruction.dst} = ${tmp}.value;`,
						poll,
					];
				}
				return [
					`static MalCallCache __cc_${ip};`,
					`MalCompletion ${tmp} = ${profileCall("string", `mal_builtin_string_char_code_at_direct(vm, &__cc_${ip}, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length})`)};`,
					`if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow()}`,
					`r${instruction.dst} = ${tmp}.value;`,
					poll,
				];
			}
			if (callPlan?.directFunctionCall) {
				const target = callPlan.directCallTargetFunctionIndex;
				const compiled = target !== undefined && directCompiledTargets.has(target);
				return [
					`static MalCallCache __cc_${ip};`,
					`MalCompletion ${tmp} = mal_vm_call_function_call_direct${compiled ? "_compiled" : ""}(vm, &__cc_${ip}, ${target === undefined ? -1 : relocation.functionIndex(target)}, ${compiled ? `mal_compiled_${target}${suffix}, ` : ""}${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length});`,
					`if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow()}`,
					`r${instruction.dst} = ${callResult(`${tmp}.value`)};`,
					poll,
				];
			}
			const directEntryParameters = (directEntry: NativeDirectEntryPlan) =>
				(directEntry.argumentRepresentations ?? directEntry.parameterRepresentations)
					.map((representation, parameter): string | null => {
						const operand = args[parameter];
						if (operand === undefined) {
							return representation === "boxed" ? "MAL_VALUE_UNDEFINED" : null;
						}
						const decoded = decodeVmValueOperand(operand);
						const boxedScalar =
							decoded?.kind === "register" && reps[decoded.register] === "boxed";
						if (representation === "number") {
							return (
								nativeNumberOperand(operand) ??
								(boxedScalar ? `mal_ops_number_as_f64(${boxedOperand(operand)})` : null)
							);
						}
						if (representation === "int32") {
							return (
								nativeInt32Operand(operand) ??
								(boxedScalar
									? `mal_ops_number_to_i32(mal_ops_number_as_f64(${boxedOperand(operand)}))`
									: null)
							);
						}
						if (representation === "boolean") {
							return (
								nativeBooleanOperand(operand) ??
								(boxedScalar ? `mal_value_to_boolean(${boxedOperand(operand)})` : null)
							);
						}
						return boxedOperand(operand);
					})
					.concat(
						directEntry.fieldParameters?.keys.map((key) => {
							const site = context.fieldEntryCall;
							const slot = site?.allocation.keyStringIndices.indexOf(key) ?? -1;
							return site === undefined || slot < 0
								? null
								: `__field_${site.allocationIp}_${slot}`;
						}) ?? [],
					);
			if (callPlan?.guardedFunctionIndices !== undefined) {
				nativeCallDecision(
					context.profile,
					ip,
					callPlan.guardedFunctionIndices.some((target) =>
						directCompiledTargets.has(target),
					)
						? "call.direct-compiled"
						: "call.direct-script",
					"guarded",
					"callee-identity-guard",
				);
				const guardedCallee = `__guarded_callee_${ip}`;
				const guardedIndex = `__guarded_index_${ip}`;
				const branches = callPlan.guardedFunctionIndices.flatMap((target, index) => {
					const exact = `__guarded_compiled_${ip}_${target}`;
					const fieldEntry = context.fieldEntryCall?.entries.find(
						(entry) => entry.functionIndex === target,
					);
					const selectedEntryId =
						fieldEntry?.entryId ??
						(callPlan.guardedFunctionIndices!.length === 1
							? callPlan.directEntryId
							: undefined);
					const entry =
						selectedEntryId === undefined
							? undefined
							: directCompiledEntries.get(
									directCompiledEntryKey(target, selectedEntryId),
								);
					const parameters =
						entry === undefined ? undefined : directEntryParameters(entry);
					if (
						entry !== undefined &&
						parameters?.every((parameter) => parameter !== null)
					) {
						const covered = context.directEntryCalls.get(ip) ?? new Set<number>();
						covered.add(target);
						context.directEntryCalls.set(ip, covered);
						const value = `__guarded_entry_value_${ip}`;
						const result =
							entry.resultRepresentation === "number"
								? `mal_ops_number_value(${value})`
								: entry.resultRepresentation === "int32"
									? `mal_value_from_i32(${value})`
									: entry.resultRepresentation === "boolean"
										? `mal_value_new_boolean(${value})`
										: value;
						const receiver = context.strictCompiledTargets.has(target)
							? boxedOperand(instruction.thisValue)
							: `mal_vm_callee_this(vm, &vm->runtime_image->functions[${target}], ${boxedOperand(instruction.thisValue)})`;
						return [
							`${index === 0 ? "if" : "else if"} (${guardedIndex} == ${target}) {`,
							`#if MAL_REALMS`,
							`  MalRealm *__entry_realm = vm->current_realm;`,
							`  mal_vm_realm_switch_to(vm, mal_vm_callee_realm(vm, ${guardedCallee}));`,
							`#endif`,
							`  if (${entry.leaf ? "mal_vm_enter_leaf_checked" : "mal_vm_enter_compiled"}(vm, ${target})) {`,
							`    MAL_PERF_COUNT(direct_entry_hits);`,
							`    ${cTypeOf(entry.resultRepresentation)} ${value} = mal_direct_${target}_${entry.id}${suffix}(vm, ${receiver}${parameters.length === 0 ? "" : `, ${parameters.join(", ")}`}, mal_value_to_function_object(${guardedCallee})->creation_env, ${guardedCallee});`,
							`    ${entry.leaf ? "mal_vm_leave_leaf_checked" : "mal_vm_leave_compiled"}(vm);`,
							`    ${tmp} = vm->completion.kind == MAL_COMPLETION_THROW ? vm->completion : (MalCompletion) { .kind = MAL_COMPLETION_NORMAL, .value = ${result} };`,
							`  } else { ${tmp} = vm->completion; }`,
							`#if MAL_REALMS`,
							`  mal_vm_realm_switch_to(vm, __entry_realm);`,
							`#endif`,
							`}`,
						];
					}
					return [
						`${index === 0 ? "if" : "else if"} (${guardedIndex} == ${relocation.functionIndex(target)}) {`,
						...(directCompiledTargets.has(target)
							? [
									`  const MalExactScriptCall ${exact} = { .callee = ${guardedCallee}, .function_index = ${target}, .compiled_callback = mal_compiled_${target}${suffix}, .function = &vm->runtime_image->functions[${target}], .env = mal_value_to_function_object(${guardedCallee})->creation_env };`,
									`  ${tmp} = mal_vm_call_exact_script_compiled_callback(vm, &${exact}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length});`,
								]
							: [
									`  ${tmp} = mal_vm_call_exact_script(vm, ${relocation.functionIndex(target)}, ${guardedCallee}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length});`,
								]),
						`}`,
					];
				});
				return [
					`static MalCallCache __cc_${ip};`,
					`MalValue ${guardedCallee} = ${boxedOperand(instruction.callee)};`,
					`i32 ${guardedIndex} = mal_value_is_function_object(${guardedCallee}) ? mal_function_object_function_index(mal_value_to_function_object(${guardedCallee})) : -1;`,
					`MalCompletion ${tmp};`,
					...branches,
					`else {`,
					`  ${tmp} = ${profileCall("call", `mal_vm_call_cached(vm, &__cc_${ip}, ${guardedCallee}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length})`)};`,
					`}`,
					`if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow()}`,
					`r${instruction.dst} = ${callResult(`${tmp}.value`)};`,
					poll,
				];
			}
			if (callPlan?.directFunctionIndex !== undefined) {
				const target = callPlan.directFunctionIndex;
				const directFunction = `__direct_function_${ip}`;
				const targetIsStrict = context.strictCompiledTargets.has(target);
				const thisArgument = targetIsStrict
					? boxedOperand(instruction.thisValue)
					: `mal_vm_callee_this(vm, ${directFunction}, ${boxedOperand(instruction.thisValue)})`;
				const functionDeclaration = targetIsStrict
					? []
					: [
							`const MalFunction *${directFunction} = &vm->runtime_image->functions[${target}];`,
						];
				const selectedEntryId =
					context.fieldEntryCall?.entries.find((entry) => entry.functionIndex === target)
						?.entryId ?? callPlan.directEntryId;
				const directEntry =
					selectedEntryId === undefined
						? undefined
						: directCompiledEntries.get(directCompiledEntryKey(target, selectedEntryId));
				if (directEntry !== undefined) {
					const directCallee = `__direct_callee_${ip}`;
					const directValue = `__direct_value_${ip}`;
					const parameters = directEntryParameters(directEntry);
					if (parameters.every((parameter) => parameter !== null)) {
						context.directEntryCalls.set(ip, new Set([target]));
						nativeCallDecision(context.profile, ip, "call.direct-native", "applied");
						const directResult =
							directEntry.resultRepresentation === "int32"
								? reps[instruction.dst] === "int32"
									? directValue
									: reps[instruction.dst] === "number"
										? `(f64) ${directValue}`
										: `mal_value_from_i32(${directValue})`
								: directEntry.resultRepresentation === "number"
									? reps[instruction.dst] === "number"
										? directValue
										: profileCall("boxing", `mal_ops_number_value(${directValue})`)
									: directEntry.resultRepresentation === "boolean"
										? reps[instruction.dst] === "boolean"
											? directValue
											: profileCall("boxing", `mal_value_new_boolean(${directValue})`)
										: callResult(directValue);
						return [
							`MalValue ${directCallee} = ${boxedOperand(instruction.callee)};`,
							`MAL_PERF_COUNT(direct_entry_hits);`,
							`if (!${directEntry.leaf ? "mal_vm_enter_leaf_checked" : "mal_vm_enter_compiled"}(vm, ${target})) ${onThrow()}`,
							...functionDeclaration,
							`${cTypeOf(directEntry.resultRepresentation)} ${directValue} = mal_direct_${target}_${directEntry.id}${suffix}(vm, ${thisArgument}${parameters.length === 0 ? "" : `, ${parameters.join(", ")}`}, mal_value_to_function_object(${directCallee})->creation_env, ${directCallee});`,
							`${directEntry.leaf ? "mal_vm_leave_leaf_checked" : "mal_vm_leave_compiled"}(vm);`,
							`if (vm->completion.kind == MAL_COMPLETION_THROW) ${onThrow()}`,
							`r${instruction.dst} = ${directResult};`,
							poll,
						];
					}
				}
				if (directCompiledTargets.has(target)) {
					nativeCallDecision(context.profile, ip, "call.direct-compiled", "applied");
					const directCallee = `__direct_callee_${ip}`;
					const directValue = `__direct_value_${ip}`;
					return [
						`MalValue ${directCallee} = ${boxedOperand(instruction.callee)};`,
						`if (!mal_vm_enter_compiled(vm, ${target})) ${onThrow()}`,
						...functionDeclaration,
						`MalValue ${directValue} = mal_compiled_${target}${suffix}(vm, ${thisArgument}, ${argsExpr}, ${args.length}, MAL_VALUE_UNDEFINED, mal_value_to_function_object(${directCallee})->creation_env, ${directCallee}, nullptr);`,
						`mal_vm_leave_compiled(vm);`,
						`if (vm->completion.kind == MAL_COMPLETION_THROW) ${onThrow()}`,
						`r${instruction.dst} = ${callResult(directValue)};`,
						poll,
					];
				}
				return [
					`static MalCallCache __cc_${ip};`,
					`MalCompletion ${tmp} = ${profileCall("call", `mal_vm_call_direct(vm, &__cc_${ip}, ${relocation.functionIndex(callPlan.directFunctionIndex)}, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length})`)};`,
					`if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow()}`,
					`r${instruction.dst} = ${callResult(`${tmp}.value`)};`,
					poll,
				];
			}
			if (mathUnaryCall) {
				const argument = instruction.arguments[0]!;
				const nativeArgument = nativeNumberOperand(argument);
				const nativeExpression =
					nativeArgument === null
						? null
						: nativeMathUnaryExpr(
								callPlan?.guardedBuiltinCall?.operation ?? "",
								nativeArgument,
							);
				if (
					nativeExpression !== null &&
					(reps[instruction.dst] === "number" ||
						(callPlan?.guardedBuiltinCall !== undefined &&
							callPlan.guardedBuiltinCall.guard.dependencies.length > 0 &&
							callPlan.guardedBuiltinCall.guard.dependencies.every(
								(dependency) =>
									dependency.kind === "world" && dependency.fact === "primordials.locked",
							)))
				) {
					return [storeNumber(instruction.dst, nativeExpression), mathPoll];
				}
				return [
					`static MalMathUnaryOp __math_${ip};`,
					`MalValue __math_result_${ip};`,
					`if (mal_builtin_math_unary_fast(${boxedOperand(instruction.callee)}, &__math_${ip}, ${boxedOperand(argument)}, &__math_result_${ip})) {`,
					`  r${instruction.dst} = __math_result_${ip};`,
					`} else {`,
					...mathFallbackRootPublication,
					`  static MalCallCache __cc_${ip};`,
					`  MalCompletion ${tmp} = ${profileCall("call", `mal_vm_call_cached(vm, &__cc_${ip}, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length})`)};`,
					`  if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow()}`,
					`  r${instruction.dst} = ${tmp}.value;`,
					`}`,
					mathPoll,
				];
			}
			if (mathBinaryCall) {
				const left = instruction.arguments[0]!;
				const right = instruction.arguments[1]!;
				const nativeLeft = nativeNumberOperand(left);
				const nativeRight = nativeNumberOperand(right);
				const nativeExpression =
					nativeLeft === null || nativeRight === null
						? null
						: nativeMathBinaryExpr(
								callPlan?.guardedBuiltinCall?.operation ?? "",
								nativeLeft,
								nativeRight,
							);
				if (
					nativeExpression !== null &&
					(reps[instruction.dst] === "number" ||
						(callPlan?.guardedBuiltinCall !== undefined &&
							callPlan.guardedBuiltinCall.guard.dependencies.length > 0 &&
							callPlan.guardedBuiltinCall.guard.dependencies.every(
								(dependency) =>
									dependency.kind === "world" && dependency.fact === "primordials.locked",
							)))
				) {
					return [storeNumber(instruction.dst, nativeExpression), mathPoll];
				}
				return [
					`static MalMathBinaryOp __math_${ip};`,
					`MalValue __math_result_${ip};`,
					`if (mal_builtin_math_binary_fast(${boxedOperand(instruction.callee)}, &__math_${ip}, ${boxedOperand(left)}, ${boxedOperand(right)}, &__math_result_${ip})) {`,
					`  r${instruction.dst} = __math_result_${ip};`,
					`} else {`,
					...mathFallbackRootPublication,
					`  static MalCallCache __cc_${ip};`,
					`  MalCompletion ${tmp} = ${profileCall("call", `mal_vm_call_cached(vm, &__cc_${ip}, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length})`)};`,
					`  if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow()}`,
					`  r${instruction.dst} = ${tmp}.value;`,
					`}`,
					mathPoll,
				];
			}
			// A per-site polymorphic call cache: exact native callees and ordinary compiled
			// closures sharing a function index skip the dispatch chain. Bound, proxy, and
			// interpreted callees stay on the slow path.
			return [
				`static MalCallCache __cc_${ip};`,
				`MalCompletion ${tmp} = ${profileCall("call", `mal_vm_call_cached(vm, &__cc_${ip}, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length})`)};`,
				`if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow()}`,
				`r${instruction.dst} = ${callResult(`${tmp}.value`)};`,
				poll, // call-return safepoint
			];
		}
		case "CONSTRUCT": {
			const constructPlan = nativePlan?.kind === "construct" ? nativePlan : undefined;
			// `new callee(args)`: marshal args (boxing numbers) and dispatch through
			// the guarded direct helper for exact script targets, otherwise generic
			// construction. Both return the completed [[Construct]] result.
			const args = instruction.arguments;
			const argsExpr =
				args.length === 0
					? "nullptr"
					: `((MalValue[]){ ${args.map(boxedOperand).join(", ")} })`;
			const tmp = `construct_result_${ip}`;
			const construct =
				constructPlan === undefined
					? profileCall(
							"construct",
							`mal_vm_construct_value(vm, ${boxedOperand(instruction.callee)}, ${argsExpr}, ${args.length})`,
						)
					: profileCall(
							"construct",
							`mal_vm_construct_direct(vm, ${relocation.functionIndex(constructPlan.directFunctionIndex)}, ${boxedOperand(instruction.callee)}, ${argsExpr}, ${args.length})`,
						);
			return [
				`MalCompletion ${tmp} = ${construct};`,
				`if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow()}`,
				`r${instruction.dst} = ${tmp}.value;`,
				poll, // call-return safepoint
			];
		}
		case "THROW":
			// Set the throw completion, then route to the enclosing handler (a
			// try/catch in this same function) or out of the frame, exactly as
			// MAL_OP_THROW + the interpreter's unwinder do.
			return [
				`vm->completion = (MalCompletion) { .kind = MAL_COMPLETION_THROW, .value = ${boxed(instruction.value)} };`,
				onThrow(),
			];
		case "LOAD_UNDECLARED":
			// An undeclared reference always throws ReferenceError; the helper sets
			// the throw completion, so route it to the handler / out of the frame.
			return [
				`mal_vm_op_load_undeclared(vm, ${relocation.stringIndex(instruction.nameStringIndex)});`,
				onThrow(),
			];
		case "TRY_BEGIN":
		case "TRY_END":
			// Markers only: the protected range becomes the per-instruction handler
			// target computed in emitBody (the `onThrow()` goto), so no code is needed.
			return [];
		case "CATCH":
			// Handler entry: bind the pending thrown value and clear the completion,
			// exactly as mal_op_catch does. The dst is boxed (any value can be caught).
			return [
				`r${instruction.dst} = vm->completion.value;`,
				`vm->completion = (MalCompletion) { .kind = MAL_COMPLETION_NORMAL, .value = MAL_VALUE_UNDEFINED };`,
			];
		case "REQUIRE_COERCIBLE":
			if (reps[instruction.src] !== "boxed") return [];
			return [
				`mal_vm_op_require_coercible(vm, ${boxed(instruction.src)});`,
				throwCheck(),
			];
		case "GET_ITERATOR": {
			const rec = `iter_rec_${ip}`;
			const lines = [
				`MalIteratorRecord ${rec};`,
				`if (!mal_vm_get_iterator(vm, ${boxed(instruction.source)}, &${rec})) ${onThrow()}`,
				`r${instruction.iteratorDst} = ${rec}.iterator;`,
				`r${instruction.nextDst} = ${rec}.next_method;`,
			];
			if (nativeIteratorCursorAction?.role === "initialize") {
				const { cursor } = nativeIteratorCursorAction;
				lines.push(
					`__iter_cursor_${cursor.initializeIp} = mal_vm_iterator_protocol_cursor(&${rec}, ${nativeIteratorCursorProtocol(cursor)});`,
				);
			}
			if (nativeArrayPairDestructureAction?.role === "initialize") {
				const id = nativeArrayPairDestructureAction.cursor.initializeIp;
				return [
					`__array_pair_${id}_fast = mal_builtin_array_pair_destructure_try(vm, ${boxed(instruction.source)}, &__array_pair_${id}_first, &__array_pair_${id}_first_done, &__array_pair_${id}_second, &__array_pair_${id}_second_done);`,
					`if (__array_pair_${id}_fast) {`,
					`  r${instruction.iteratorDst} = MAL_VALUE_UNDEFINED;`,
					`  r${instruction.nextDst} = MAL_VALUE_UNDEFINED;`,
					`  __iter_cursor_${id} = nullptr;`,
					`} else {`,
					...lines.map((line) => `  ${line}`),
					`}`,
				];
			}
			if (nativeIteratorEntryPairVirtualizationAction?.role === "innerInitialize") {
				const id = nativeIteratorEntryPairVirtualizationAction.region.outerStepIp;
				return [
					`if (__iter_entry_pair_${id}_fast) {`,
					`  r${instruction.iteratorDst} = MAL_VALUE_UNDEFINED;`,
					`  r${instruction.nextDst} = MAL_VALUE_UNDEFINED;`,
					`} else {`,
					...lines.map((line) => `  ${line}`),
					`}`,
				];
			}
			return lines;
		}
		case "GET_ASYNC_ITERATOR": {
			// GetIterator(source, async): fetch @@asyncIterator (falling back to a
			// sync iterator wrapped as async). A missing/throwing method propagates.
			const rec = `aiter_rec_${ip}`;
			return [
				`MalIteratorRecord ${rec};`,
				`if (!mal_vm_get_async_iterator(vm, ${boxed(instruction.source)}, &${rec})) ${onThrow()}`,
				`r${instruction.iteratorDst} = ${rec}.iterator;`,
				`r${instruction.nextDst} = ${rec}.next_method;`,
			];
		}
		case "ITERATOR_STEP": {
			if (nativeIteratorEntryPairVirtualizationAction?.role === "outerStep") {
				const { region } = nativeIteratorEntryPairVirtualizationAction;
				const rec = `iter_rec_${ip}`;
				const val = `iter_val_${ip}`;
				const done = `iter_done_${ip}`;
				return [
					`MalIteratorRecord ${rec} = { .iterator = ${boxed(instruction.iterator)}, .next_method = ${boxed(instruction.next)} };`,
					`MalValue ${val} = MAL_VALUE_UNDEFINED; bool ${done};`,
					`__iter_entry_pair_${ip}_fast = ${regionAdmissionGuard(region.license)} && mal_vm_iterator_step_entry_pair_protocol_cursor(vm, &${rec}, &__iter_entry_pair_${ip}_first, &__iter_entry_pair_${ip}_second, &${done});`,
					`if (!__iter_entry_pair_${ip}_fast && vm->completion.kind == MAL_COMPLETION_THROW) ${onThrow()}`,
					`if (__iter_entry_pair_${ip}_fast) { MAL_PERF_COUNT(iterator_entry_pair_hits); } else { MAL_PERF_COUNT(iterator_entry_pair_fallbacks); }`,
					`if (!__iter_entry_pair_${ip}_fast && !mal_vm_iterator_step(vm, &${rec}, &${val}, &${done})) ${onThrow()}`,
					`r${instruction.valueDst} = __iter_entry_pair_${ip}_fast ? MAL_VALUE_UNDEFINED : ${val};`,
					reps[instruction.doneDst] === "boolean"
						? `r${instruction.doneDst} = ${done};`
						: `r${instruction.doneDst} = ${profileCall("boxing", `mal_value_new_boolean(${done})`)};`,
				];
			}
			if (nativeIteratorEntryPairVirtualizationAction?.role === "innerStep") {
				const { region, index } = nativeIteratorEntryPairVirtualizationAction;
				const fallback = emitGenericInstruction();
				if (fallback === null || index === undefined) return null;
				const id = region.outerStepIp;
				const value =
					index === 0
						? `__iter_entry_pair_${id}_first`
						: `__iter_entry_pair_${id}_second`;
				return [
					`if (__iter_entry_pair_${id}_fast) {`,
					`  r${instruction.valueDst} = ${value};`,
					...(reps[instruction.doneDst] === "boolean"
						? [`  r${instruction.doneDst} = false;`]
						: [
								`  r${instruction.doneDst} = ${profileCall("boxing", `mal_value_new_boolean(false)`)};`,
							]),
					`} else {`,
					...fallback.map((line) => `  ${line}`),
					`}`,
				];
			}
			const rec = `iter_rec_${ip}`;
			const val = `iter_val_${ip}`;
			const done = `iter_done_${ip}`;
			const virtualResult =
				nativeIteratorResultVirtualizationAction !== undefined ||
				nativeRegExpIteratorProjectionAction?.role === "step";
			if (nativeIteratorResultVirtualizationAction !== undefined) {
				regionAdmissionGuard(nativeIteratorResultVirtualizationAction.region.license);
			}
			const genericStep = virtualResult
				? `mal_vm_iterator_step_fast(vm, &${rec}, &${val}, &${done})`
				: `mal_vm_iterator_step(vm, &${rec}, &${val}, &${done})`;
			const cursorInitializeIp =
				nativeIteratorCursorAction?.role === "step"
					? nativeIteratorCursorAction.cursor.initializeIp
					: undefined;
			const cursorStep =
				cursorInitializeIp === undefined
					? undefined
					: nativeIteratorCursorAction?.cursor.protocol === "array-values"
						? `mal_vm_iterator_step_dense_array_cursor(vm, __iter_cursor_${cursorInitializeIp}, &${rec}, &${val}, &${done})`
						: `mal_vm_iterator_step_protocol_cursor(vm, __iter_cursor_${cursorInitializeIp}, &${val}, &${done})`;
			const step =
				cursorStep !== undefined
					? `(__iter_cursor_${cursorInitializeIp} != nullptr ? ${cursorStep} : ${genericStep})`
					: genericStep;
			if (nativeRegExpIteratorProjectionAction?.role === "step") {
				const site = nativeRegExpIteratorProjectionAction.site;
				const admission = regionAdmissionGuard(site.projection.license);
				const indices = site.loads.map((load) => load.captureIndex).join(", ");
				const outputs = site.loads
					.map((_load, index) => `&__gc_slots[${site.slotsOffset + index}]`)
					.join(", ");
				const status = `regexp_iter_status_${ip}`;
				return [
					`MalIteratorRecord ${rec} = { .iterator = ${boxed(instruction.iterator)}, .next_method = ${boxed(instruction.next)} };`,
					`MalValue ${val}; bool ${done};`,
					`__regexp_iter_${site.projection.stepIp}_projected = false;`,
					`int ${status} = ${admission} ? ${profileCall("regexp", `mal_regexp_try_exact_iterator_capture_projection(vm, ${boxed(instruction.iterator)}, ${boxed(instruction.next)}, (const u32[]){ ${indices} }, (MalValue *[]){ ${outputs} }, ${site.loads.length}, __regexp_iter_${site.projection.stepIp}_starts, __regexp_iter_${site.projection.stepIp}_ends, &__gc_slots[${site.subjectSlot}], &${val}, &${done})`)} : 0;`,
					`if (${status} < 0) ${onThrow()}`,
					`if (${status} == 0 && !(${step})) ${onThrow()}`,
					`__regexp_iter_${site.projection.stepIp}_projected = ${status} > 0 && mal_value_is_boolean(${val});`,
					`r${instruction.valueDst} = ${val};`,
					reps[instruction.doneDst] === "boolean"
						? `r${instruction.doneDst} = ${done};`
						: `r${instruction.doneDst} = ${profileCall("boxing", `mal_value_new_boolean(${done})`)};`,
				];
			}
			const lines = [
				`MalIteratorRecord ${rec} = { .iterator = ${boxed(instruction.iterator)}, .next_method = ${boxed(instruction.next)} };`,
				`MalValue ${val}; bool ${done};`,
				`if (!(${step})) ${onThrow()}`,
				`r${instruction.valueDst} = ${val};`,
				reps[instruction.doneDst] === "boolean"
					? `r${instruction.doneDst} = ${done};`
					: `r${instruction.doneDst} = ${profileCall("boxing", `mal_value_new_boolean(${done})`)};`,
			];
			if (nativeArrayPairDestructureAction?.role === "step") {
				const id = nativeArrayPairDestructureAction.cursor.initializeIp;
				const suffix = nativeArrayPairDestructureAction.index === 0 ? "first" : "second";
				return [
					`if (__array_pair_${id}_fast) {`,
					`  r${instruction.valueDst} = __array_pair_${id}_${suffix};`,
					...(reps[instruction.doneDst] === "boolean"
						? [`  r${instruction.doneDst} = __array_pair_${id}_${suffix}_done;`]
						: [
								`  r${instruction.doneDst} = ${profileCall("boxing", `mal_value_new_boolean(__array_pair_${id}_${suffix}_done)`)};`,
							]),
					`} else {`,
					...lines.map((line) => `  ${line}`),
					`}`,
				];
			}
			return lines;
		}
		case "ITERATOR_CLOSE": {
			if (nativeIteratorEntryPairVirtualizationAction?.role === "innerClose") {
				const fallback = emitGenericInstruction();
				if (fallback === null) return null;
				const id = nativeIteratorEntryPairVirtualizationAction.region.outerStepIp;
				return [
					`if (!__iter_entry_pair_${id}_fast) {`,
					...fallback.map((line) => `  ${line}`),
					`}`,
				];
			}
			const rec = `iter_rec_${ip}`;
			if (instruction.normal) {
				// Normal-completion close: propagate return()'s throw and TypeError
				// on a non-object result.
				const lines = [
					`MalIteratorRecord ${rec} = { .iterator = ${boxed(instruction.iterator)}, .next_method = MAL_VALUE_UNDEFINED };`,
					`if (!mal_vm_iterator_close_normal(vm, &${rec})) ${onThrow()}`,
				];
				if (nativeArrayPairDestructureAction?.role === "close") {
					const id = nativeArrayPairDestructureAction.cursor.initializeIp;
					return [
						`if (!__array_pair_${id}_fast) {`,
						...lines.map((line) => `  ${line}`),
						`}`,
					];
				}
				return lines;
			}
			return [
				`MalIteratorRecord ${rec} = { .iterator = ${boxed(instruction.iterator)}, .next_method = MAL_VALUE_UNDEFINED };`,
				`mal_vm_iterator_close(vm, &${rec});`,
				throwCheck(),
			];
		}
		case "JUMP":
			// A back-edge (target <= current ip) is a loop edge: poll there so an
			// allocation-free loop is still interruptible for collection.
			return instruction.targetIp <= ip
				? [poll, `goto L${instruction.targetIp};`]
				: [`goto L${instruction.targetIp};`];
		case "JUMP_IF":
			// Branch on a raw bool / native truthiness test — no boxing when the
			// condition is already a boolean-rep (typically a comparison result).
			// Poll on a taken back-edge only.
			return instruction.targetIp <= ip
				? [`if (${truthy(instruction.cond)}) { ${poll} goto L${instruction.targetIp}; }`]
				: [`if (${truthy(instruction.cond)}) goto L${instruction.targetIp};`];
		case "RETURN": {
			// Register -1 is the "no value" sentinel (a synthesized empty return).
			let value =
				instruction.value < 0 ? "MAL_VALUE_UNDEFINED" : boxed(instruction.value);
			if (directResultRepresentation !== undefined) {
				if (stackObjectMaterialization !== undefined) return null;
				if (instruction.value < 0) {
					return [`${gcUnlink}return ${zeroOf(directResultRepresentation)};`];
				}
				const directValue =
					directResultRepresentation === "int32"
						? reps[instruction.value] === "int32"
							? `r${instruction.value}`
							: `mal_ops_number_to_i32(${num(instruction.value)})`
						: directResultRepresentation === "number"
							? reps[instruction.value] === "number"
								? `r${instruction.value}`
								: `mal_ops_number_as_f64(${boxed(instruction.value)})`
							: directResultRepresentation === "boolean"
								? reps[instruction.value] === "boolean"
									? `r${instruction.value}`
									: `mal_value_to_boolean(${boxed(instruction.value)})`
								: boxed(instruction.value);
				return [`${gcUnlink}return ${directValue};`];
			}
			const materialize: Array<string> = [];
			if (stackObjectMaterialization !== undefined) {
				const materialized = `materialized_ret_${ip}`;
				materialize.push(
					`MalValue ${materialized} = mal_vm_materialize_stack_object(vm, &${stackObjectMaterialization.objectName});`,
					throwCheck(),
				);
				value = materialized;
			}
			// A coroutine body's return completes the activation: free its buffer and
			// settle its promise / hand the value to the .next() driver.
			if (coro !== null) {
				return [
					...materialize,
					`mal_vm_op_coroutine_return_compiled(vm, __coro, ${value});`,
					`${gcUnlink}return ${coroReturnValue};`,
				];
			}
			// A derived constructor substitutes the super-bound `this` for a
			// non-object return, and returning before super() bound it is a
			// ReferenceError — so route through the checked helper (which can throw).
			if (thisSlot >= 0) {
				const ret = `derived_ret_${ip}`;
				return [
					...materialize,
					`MalValue ${ret} = mal_vm_op_derived_construct_return(vm, ${value}, ${thisRef});`,
					throwCheck(),
					`${gcUnlink}return ${ret};`,
				];
			}
			if (!hasPrototype) {
				return [...materialize, `${gcUnlink}return ${value};`];
			}
			// Route through mal_ops_construct_result so a [[Construct]] invocation
			// (new_target set) substitutes `this` for a non-object completion; a
			// plain call passes the value through unchanged.
			return [
				...materialize,
				`${gcUnlink}return mal_ops_construct_result(${value}, this_value, ${nativeBodyReference(resources, "newTarget")});`,
			];
		}
		case "LOAD_GLOBAL_PROPERTY":
			return [
				`r${instruction.dst} = mal_vm_op_load_global_property(vm, ${relocation.stringIndex(instruction.nameStringIndex)});`,
				throwCheck(),
			];
		case "LOAD_PROTOTYPE":
			// Reads the internal [[Prototype]] slot directly (no proxy trap) — never throws.
			return [
				`r${instruction.dst} = mal_vm_op_load_prototype(vm, ${boxed(instruction.object)});`,
			];
		case "LOAD_SUPER_PROPERTY":
			return [
				`r${instruction.dst} = mal_vm_op_load_super_property(vm, ${boxed(instruction.object)}, ${boxed(instruction.key)}, ${boxed(instruction.receiver)});`,
				throwCheck(),
			];
		case "SET_FUNCTION_NAME":
			// Installs the "name" data property from an already-evaluated key; no user code.
			return [
				`mal_vm_op_set_function_name(vm, ${boxed(instruction.func)}, ${boxed(instruction.key)}, ${instruction.prefix});`,
			];
		case "ITERATOR_NEXT": {
			// IteratorNext: call `next` with the iterator as `this` and no args, exactly
			// like a 0-arg CALL. A throw propagates via the completion.
			const tmp = `iter_next_${ip}`;
			return [
				`MalCompletion ${tmp} = mal_vm_call_value(vm, ${boxed(instruction.next)}, ${boxed(instruction.iterator)}, nullptr, 0);`,
				`if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow()}`,
				`r${instruction.resultDst} = ${tmp}.value;`,
				poll, // call-return safepoint
			];
		}
		case "CREATE_TEMPLATE_OBJECT": {
			const count = instruction.cookedIndices.length;
			const cooked =
				count > 0
					? `(const i32[]){ ${instruction.cookedIndices.map((index) => (index < 0 ? String(index) : relocation.stringIndex(index))).join(", ")} }`
					: "nullptr";
			const raw =
				count > 0
					? `(const i32[]){ ${instruction.rawIndices.map((index) => relocation.stringIndex(index)).join(", ")} }`
					: "nullptr";
			return [
				`r${instruction.dst} = mal_vm_op_create_template_object(vm, ${relocation.globalIndex(instruction.cacheSlot)}, ${count}, ${cooked}, ${raw});`,
			];
		}
		case "CREATE_MODULE_NAMESPACE": {
			const count = instruction.nameIndices.length;
			const names =
				count > 0
					? `(const i32[]){ ${instruction.nameIndices.map((index) => relocation.stringIndex(index)).join(", ")} }`
					: "nullptr";
			const slots =
				count > 0
					? `(const i32[]){ ${instruction.slots.map((index) => relocation.globalIndex(index)).join(", ")} }`
					: "nullptr";
			return [
				`r${instruction.dst} = mal_vm_op_create_module_namespace(vm, ${instruction.cacheSlot < 0 ? "-1" : relocation.globalIndex(instruction.cacheSlot)}, ${count}, ${names}, ${slots});`,
			];
		}
		case "COPY_DATA_PROPERTIES": {
			// Object rest `{...rest}`: excluded keys are the sibling destructured
			// registers, boxed into a temp array (rooted originals + no synchronous
			// collection keep the copies live). A source getter can throw.
			const excluded =
				instruction.excluded.length > 0
					? `((MalValue[]){ ${instruction.excluded.map((r) => boxed(r)).join(", ")} })`
					: "nullptr";
			return [
				`r${instruction.dst} = mal_vm_op_copy_data_properties(vm, ${boxed(instruction.src)}, ${excluded}, ${instruction.excludedCount});`,
				throwCheck(),
			];
		}
		case "CREATE_PRIVATE_NAME":
			// A fresh unique private name (hidden symbol); never throws.
			return [`r${instruction.dst} = mal_vm_op_create_private_name(vm);`];
		case "CREATE_PRIVATE_NAMES":
			return [
				`mal_vm_op_create_private_names(vm, env, ${relocation.ownerFunctionIndex(instruction.ownerFunctionIndex)}, ${instruction.capturedIndices.length}, (const i32[]){ ${instruction.capturedIndices.join(", ")} });`,
			];
		case "DEFINE_PRIVATE":
			// AddPrivateName on a fresh instance/class object; a duplicate install throws.
			return [
				`mal_vm_op_define_private(vm, ${boxed(instruction.object)}, ${boxed(instruction.key)}, ${boxed(instruction.value)});`,
				throwCheck(),
			];
		case "INIT_PRIVATE_FIELDS":
			return [
				`mal_vm_op_init_private_fields(vm, ${boxed(instruction.object)}, ${instruction.keyRegisters.length}, (const MalValue[]){ ${instruction.keyRegisters.map((key) => boxed(key)).join(", ")} });`,
				throwCheck(),
			];
		case "LOAD_PRIVATE": {
			return [
				`r${instruction.dst} = mal_vm_op_load_private(vm, ${boxed(instruction.object)}, ${boxed(instruction.key)});`,
				throwCheck(),
			];
		}
		case "STORE_PRIVATE":
			// PrivateSet; the name must already be installed, else throws.
			return [
				`mal_vm_op_store_private(vm, ${boxed(instruction.object)}, ${boxed(instruction.key)}, ${boxed(instruction.value)});`,
				throwCheck(),
			];
		case "HAS_PRIVATE":
			// Ergonomic brand check `#x in obj`; a non-object receiver throws.
			return [
				reps[instruction.dst] === "boolean"
					? `r${instruction.dst} = mal_value_to_boolean(mal_vm_op_has_private(vm, ${boxed(instruction.object)}, ${boxed(instruction.key)}));`
					: `r${instruction.dst} = mal_vm_op_has_private(vm, ${boxed(instruction.object)}, ${boxed(instruction.key)});`,
				throwCheck(),
			];
		case "CALL_SPREAD": {
			// `f(...args)`: marshal the spread array and dispatch, mirroring CALL.
			const tmp = `call_spread_${ip}`;
			return [
				`MalCompletion ${tmp} = mal_vm_op_call_spread(vm, ${boxed(instruction.callee)}, ${boxed(instruction.thisValue)}, ${boxed(instruction.argumentsArray)});`,
				`if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow()}`,
				`r${instruction.dst} = ${tmp}.value;`,
				poll, // call-return safepoint
			];
		}
		case "CALL_REST_ARGUMENTS": {
			const tmp = `call_rest_${ip}`;
			return [
				`MalCompletion ${tmp} = mal_vm_op_call_rest_arguments(vm, ${boxed(instruction.callee)}, ${boxed(instruction.thisValue)}, ${boxed(instruction.receiver)}, args, arg_count, ${instruction.startIndex}, ${instruction.apply});`,
				`if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow()}`,
				`r${instruction.dst} = ${tmp}.value;`,
				poll,
			];
		}
		case "CALL_SPREAD_ITERABLE": {
			// `f(...iterable)` with no other arguments: observe GetIterator,
			// then let the runtime use its guarded dense-Array path.
			const tmp = `call_spread_iterable_${ip}`;
			return [
				`MalCompletion ${tmp} = mal_vm_op_call_spread_iterable(vm, ${boxed(instruction.callee)}, ${boxed(instruction.thisValue)}, ${boxed(instruction.iterable)});`,
				`if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow()}`,
				`r${instruction.dst} = ${tmp}.value;`,
				poll, // call-return safepoint
			];
		}
		case "CONSTRUCT_SPREAD": {
			// `new C(...args)`: marshal the spread array and dispatch, mirroring CONSTRUCT.
			const tmp = `construct_spread_${ip}`;
			return [
				`MalCompletion ${tmp} = mal_vm_op_construct_spread(vm, ${boxed(instruction.callee)}, ${boxed(instruction.argumentsArray)});`,
				`if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow()}`,
				`r${instruction.dst} = ${tmp}.value;`,
				poll, // call-return safepoint
			];
		}
		case "WITH_ENTER": {
			// Push a `with` object environment record onto the env chain (nil throws).
			// A temp holds the new env so a throw leaves `env` at the pre-with scope for
			// an in-function handler. Keeping the with-object on the env chain (not a
			// frame-local stack) lets closures created in the body capture it.
			const tmp = `with_env_${ip}`;
			const frameUpdate = gcUnlink !== "" ? " __gc_frame.env = env;" : "";
			return [
				`MalEnv *${tmp} = mal_vm_op_with_enter(vm, env, ${boxed(instruction.object)});`,
				throwCheck(),
				`env = ${tmp};${frameUpdate}`,
			];
		}
		case "WITH_EXIT": {
			// Pop the with-env pushed by the matching WITH_ENTER.
			const frameUpdate = gcUnlink !== "" ? " __gc_frame.env = env;" : "";
			return [`env = env->parent;${frameUpdate}`];
		}
		case "WITH_GET":
			// Resolve a name against the with-envs on the chain; EMPTY sentinel on a miss
			// (the IR then falls back to the static binding). A getter / @@unscopables
			// can throw.
			return [
				`r${instruction.dst} = mal_vm_op_with_get(vm, env, ${relocation.stringIndex(instruction.nameStringIndex)});`,
				throwCheck(),
			];
		case "WITH_RESOLVE_BASE":
			// The reference base (the with-object itself) for a read/write through it.
			return [
				`r${instruction.dst} = mal_vm_op_with_resolve_base(vm, env, ${relocation.stringIndex(instruction.nameStringIndex)});`,
				throwCheck(),
			];
		case "WITH_SET":
			// Assign through the with-envs; `found` (always boxed-rep) reports whether a
			// binding matched so the IR can fall back to the static binding on a miss.
			return [
				`r${instruction.found} = ${profileCall("boxing", `mal_value_new_boolean(mal_vm_op_with_set(vm, env, ${relocation.stringIndex(instruction.nameStringIndex)}, ${boxed(instruction.value)}))`)};`,
				throwCheck(),
			];
		case "CHECK_SUPER_CLASS":
			// ClassDefinitionEvaluation heritage check; a bad `extends` value throws.
			return [
				`mal_vm_op_check_super_class(vm, ${boxed(instruction.parent)});`,
				throwCheck(),
			];
		case "STORE_SUPER_PROPERTY":
			// `super.p = v`: the base descriptor governs, the write hits `receiver`.
			// A setter or a strict-mode rejection throws.
			return [
				`mal_vm_op_store_super_property(vm, ${boxed(instruction.object)}, ${boxed(instruction.key)}, ${boxed(instruction.value)}, ${boxed(instruction.receiver)}, ${strict});`,
				throwCheck(),
			];
		case "CONSTRUCT_SUPER": {
			// `super(...args)`: construct the parent, bind the result as this activation's
			// (rooted, mutable) `this`, and yield it. Only appears in derived
			// constructors, so `thisRef` is always the rooted this-slot.
			const tmp = `construct_super_${ip}`;
			return [
				`MalCompletion ${tmp} = mal_vm_op_construct_super(vm, ${boxed(instruction.parent)}, ${boxed(instruction.argumentsArray)}, ${nativeBodyReference(resources, "newTarget")}, ${thisRef}, &${thisRef});`,
				`if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow()}`,
				`r${instruction.dst} = ${thisRef};`,
				poll, // call-return safepoint
			];
		}
		case "CONSTRUCT_SUPER_EXPLICIT": {
			const completion = `construct_super_explicit_${ip}`;
			const boundThis = `bound_super_this_${ip}`;
			return [
				`MalValue ${boundThis};`,
				`MalCompletion ${completion} = mal_vm_op_construct_super(vm, ${boxed(instruction.parent)}, ${boxed(instruction.argumentsArray)}, ${boxed(instruction.newTarget)}, ${boxed(instruction.dst)}, &${boundThis});`,
				`if (${completion}.kind == MAL_COMPLETION_THROW) ${onThrow()}`,
				`r${instruction.dst} = ${boundThis};`,
				poll,
			];
		}
		case "SET_THIS":
			if (thisSlot < 0) return null;
			return [`${thisRef} = ${boxed(instruction.value)};`];
		case "GENERATOR_START": {
			// Resumable functions only. Build the generator/async-generator instance
			// adopting this activation's buffer, then suspend at the next instruction
			// and hand the generator back to the caller (the first .next() resumes it).
			if (coro === null) {
				return null;
			}
			return [
				`__coro = mal_vm_op_generator_start_compiled(vm, callee, ${coro.functionIndex}, this_value, env, __gc_slots, args, arg_count, ${coro.retainArguments}, ${ip + 1}, ${coro.isAsyncGenerator});`,
				`__gc_slots[${coro.selfSlot}] = mal_value_from_object((MalObject *) __coro);`,
				`${gcUnlink}return mal_value_from_object((MalObject *) __coro);`,
			];
		}
		case "YIELD": {
			// Record the yielded value, resume registers, and resume point on the
			// coroutine, save the current env, then suspend (return). A resume
			// re-enters at ip+1, where the front-end's inline dispatch reads the mode.
			if (coro === null) {
				return null;
			}
			return [
				`mal_vm_op_yield_compiled(vm, __coro, ${boxed(instruction.yieldedSrc)}, ${instruction.valueDst}, ${instruction.modeDst}, ${ip + 1}, env);`,
				`${gcUnlink}return ${coroReturnValue};`,
			];
		}
		case "TERMINAL_YIELD": {
			if (coro === null || coro.isAsyncFunction || coro.isAsyncGenerator) {
				return null;
			}
			return [
				`mal_vm_op_terminal_yield_compiled(vm, __coro, ${boxed(instruction.yieldedSrc)});`,
				`${gcUnlink}mal_generator_release_frame(vm, __coro); return ${coroReturnValue};`,
			];
		}
		case "ASYNC_START": {
			// Create the result promise + hidden async state adopting this
			// activation's buffer; unlike GENERATOR_START the body keeps running (no
			// suspend). Every later exit returns the promise (__async_result_promise).
			if (coro === null) {
				return null;
			}
			return [
				`__coro = mal_vm_op_async_start_compiled(vm, callee, ${coro.functionIndex}, this_value, env, __gc_slots, args, arg_count, ${coro.retainArguments}, &__async_result_promise);`,
				`__gc_slots[${coro.selfSlot}] = mal_value_from_object((MalObject *) __coro);`,
			];
		}
		case "AWAIT": {
			// Suspend on the awaited value: record the resume registers/point + env,
			// hook the settlement continuation, and return. A resume re-enters at ip+1
			// where the front-end's inline dispatch reads the delivered value/mode.
			if (coro === null) {
				return null;
			}
			return [
				`mal_vm_op_await_compiled(vm, __coro, ${boxed(instruction.awaitedSrc)}, ${instruction.valueDst}, ${instruction.modeDst}, ${ip + 1}, env);`,
				`${gcUnlink}return ${coroReturnValue};`,
			];
		}
		default:
			// Not lowered yet — the function stays on the interpreter. This is the
			// blank to fill in (calls, property access, captures, ...).
			return null;
	}
}

export type { RegisterRep };
