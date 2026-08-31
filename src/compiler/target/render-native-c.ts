import type { CorePropertyPlacement } from "../core/core-ir-regions.ts";
import {
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_NUMBER_OR_UNDEFINED,
	COMPILER_VALUE_KIND_UNDEFINED,
} from "../shared/compiler-value-kinds.ts";
import type { CompilerValueKindMask } from "../shared/compiler-value-kinds.ts";
import {
	emitBinaryOperator,
	emitIntrinsic,
	emitTypeofResult,
	emitUnaryOperator,
} from "./emit-program-image.ts";
import { profileOperationForInstruction } from "./profile-metadata.ts";
import {
	nativeFrameRootRegisters,
	vmCallProvesBuiltin,
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

export interface BackendProfileDecision {
	instructionIndex: number;
	operation: string;
	code: string;
	outcome: "applied" | "elided" | "guarded" | "retained" | "fallback";
	reasonCode?: string;
	details?: Record<string, string | number | boolean>;
}

const MATH_UNARY_NATIVE_OP: ReadonlyMap<string, string> = new Map([
	["Math.abs", "MAL_MATH_UNARY_ABS"],
	["Math.floor", "MAL_MATH_UNARY_FLOOR"],
	["Math.ceil", "MAL_MATH_UNARY_CEIL"],
	["Math.round", "MAL_MATH_UNARY_ROUND"],
	["Math.trunc", "MAL_MATH_UNARY_TRUNC"],
	["Math.sqrt", "MAL_MATH_UNARY_SQRT"],
	["Math.cbrt", "MAL_MATH_UNARY_CBRT"],
	["Math.sign", "MAL_MATH_UNARY_SIGN"],
	["Math.log", "MAL_MATH_UNARY_LOG"],
	["Math.log2", "MAL_MATH_UNARY_LOG2"],
	["Math.log10", "MAL_MATH_UNARY_LOG10"],
	["Math.exp", "MAL_MATH_UNARY_EXP"],
	["Math.sin", "MAL_MATH_UNARY_SIN"],
	["Math.cos", "MAL_MATH_UNARY_COS"],
	["Math.tan", "MAL_MATH_UNARY_TAN"],
	["Math.asin", "MAL_MATH_UNARY_ASIN"],
	["Math.acos", "MAL_MATH_UNARY_ACOS"],
	["Math.atan", "MAL_MATH_UNARY_ATAN"],
	["Math.sinh", "MAL_MATH_UNARY_SINH"],
	["Math.cosh", "MAL_MATH_UNARY_COSH"],
	["Math.tanh", "MAL_MATH_UNARY_TANH"],
	["Math.asinh", "MAL_MATH_UNARY_ASINH"],
	["Math.acosh", "MAL_MATH_UNARY_ACOSH"],
	["Math.atanh", "MAL_MATH_UNARY_ATANH"],
	["Math.log1p", "MAL_MATH_UNARY_LOG1P"],
	["Math.expm1", "MAL_MATH_UNARY_EXPM1"],
	["Math.fround", "MAL_MATH_UNARY_FROUND"],
] as const);

const MATH_BINARY_NATIVE_OP: ReadonlyMap<string, string> = new Map([
	["Math.min", "MAL_MATH_BINARY_MIN"],
	["Math.max", "MAL_MATH_BINARY_MAX"],
] as const);

export interface CompiledFunction {
	/** The C symbol to install as MalFunction.compiled. */
	symbol: string;
	/** Final decisions from the exact emitted variant, never an exploratory pass. */
	profileDecisions: Array<BackendProfileDecision>;
	/** The full `static MalValue ...(...) { ... }` definition. */
	source: string;
	/** Additional native-only ordinary-call symbols emitted beside the canonical body. */
	directEntries: Array<{
		id: number;
		symbol: string;
		/**
		 * Independently emitted definition so an optional ABI sibling cannot evict the canonical body.
		 */
		source: string;
		parameterRepresentations: ReadonlyArray<VmRegisterRepresentation>;
		resultRepresentation: VmRegisterRepresentation;
	}>;
}

export type DirectCompiledEntries = ReadonlyMap<string, NativeDirectEntryPlan>;

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

/**
 * Unary ops that can raise: `+` on a BigInt, and `tonumeric` (the
 * UpdateExpression coercion) on a Symbol or a throwing `valueOf`. Both need a
 * completion check after the call.
 */
const THROWING_UNARY_OPERATORS = new Set(["+", "tonumeric"]);

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

/**
 * Whether a binary operator yields a JS Number from two Number operands — native
 * arithmetic, the bitwise/shift operators, unsigned shift, and remainder. Such a
 * result is `number`-rep (the integer-valued ones held exactly as a double).
 * `**` is excluded: it stays boxed (its Number::exponentiate special cases are
 * not worth inlining yet).
 */
function producesNumberFromNumbers(operator: string): boolean {
	return (
		operator in NATIVE_ARITH ||
		operator in NATIVE_BITWISE ||
		operator === ">>>" ||
		operator === "%"
	);
}

/**
 * The native C expression (an f64) computing `left <op> right` for a
 * number-producing operator over two f64 operand expressions, or null if the
 * operator does not produce a Number from Numbers. Bitwise/shift ops go through
 * ToInt32 (mal_ops_number_to_i32) with the shift count masked to 5 bits; `>>>`
 * yields a uint32; `%` uses the integer-fast-path remainder. Shared by both the
 * pure-`number` result path (raw) and the mixed-rep guarded fast path (which
 * re-boxes with mal_ops_number_value), so the two never drift.
 */
function nativeNumberExpr(operator: string, left: string, right: string): string | null {
	const arith = NATIVE_ARITH[operator];
	if (arith !== undefined) {
		return `${left} ${arith} ${right}`;
	}
	const bitwise = NATIVE_BITWISE[operator];
	if (bitwise !== undefined) {
		if (operator === "<<") {
			return `(f64) mal_ops_u32_to_i32((u32) mal_ops_number_to_i32(${left}) << (mal_ops_number_to_i32(${right}) & 0x1F))`;
		}
		const right32 =
			operator === ">>"
				? `(mal_ops_number_to_i32(${right}) & 0x1F)`
				: `mal_ops_number_to_i32(${right})`;
		return `(f64) (mal_ops_number_to_i32(${left}) ${bitwise} ${right32})`;
	}
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
	const masks = new Map<number, bigint>();
	let removesAnyRoot = false;
	for (const safepoint of safepoints) {
		const roots = new Set(safepoint.rootRegisters);
		let mask = 0n;
		for (const [register, slot] of slotOfRegister) {
			if (slot < 64 && !roots.has(register)) mask |= 1n << BigInt(slot);
		}
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
		);
	}
	const nativeContract: NativeFunctionPlan =
		directEntry === undefined
			? native
			: {
					...native,
					registerRepresentations: directEntry.registerRepresentations,
					gc: directEntry.gc,
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
		const isBoxed = reps[i] !== "number" && reps[i] !== "boolean";
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
		stackObjectSites.set(site.allocationIp, {
			objectName: `__stack_object_${site.allocationIp}`,
			...(scalarSlotRepresentation === undefined
				? { slotsOffset: nextStackSlot }
				: {
						scalarSlot: {
							name: `__stack_object_${site.allocationIp}_slot_0`,
							representation: scalarSlotRepresentation,
						},
					}),
			slotCount: site.slotCount,
		});
		if (scalarSlotRepresentation === undefined) nextStackSlot += site.slotCount;
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
					instruction?.opcode !== "STORE_PROPERTY_STATIC") ||
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
	const totalSlots = nextStackSlot;

	// `with` pushes an object environment record onto the `env` chain (WITH_ENTER),
	// so a with-function reassigns `env` and needs the root frame to keep the live
	// with-env rooted (the with-object is live across property accesses in the body).
	const hasWith = fn.instructions.some((i) => i.opcode === "WITH_ENTER");

	// A root frame is needed to scan MalValue registers, a derived constructor's
	// `this`, this activation's captured env, and/or a reassigned `with` env; every
	// exit past its link must unlink it.
	const needsRootFrame = totalSlots > 0 || capturesEnv || hasWith;
	const gcUnlink = needsRootFrame ? "mal_root_frame_head = __gc_frame.prev; " : "";

	const profileDecisions: Array<BackendProfileDecision> = [];
	const body = emitBody(
		fn,
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
	);
	if (body === null) {
		return null;
	}

	// Defensive: a register operand of -1 (a "no register" sentinel beyond the
	// RETURN case handled below) would emit invalid C like `r-1`. Bail to the
	// interpreter rather than emit broken code.
	if (body.some((line) => /\br-\d/.test(line))) {
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
			: directEntry.parameterRepresentations.map(
					(representation, parameter) => `${cTypeOf(representation)} p${parameter}`,
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
	if (directEntry !== undefined && body.some((line) => line.includes("new_target"))) {
		lines.push(`    const MalValue new_target = MAL_VALUE_UNDEFINED;`);
	}
	if (
		body.some(
			(line) =>
				line.includes("__property_ic") ||
				line.includes("__property_function_index") ||
				line.includes("__literal_shapes"),
		)
	) {
		lines.push(
			`    mal_vm_ensure_function_caches(vm, ${relocation.functionIndex(index)});`,
		);
	}
	if (body.some((line) => line.includes("__property_ic"))) {
		lines.push(
			`    MalInlineCache *__property_ic = vm->property_cache[${relocation.functionIndex(index)}].sites;`,
		);
	}
	if (body.some((line) => line.includes("__property_function_index"))) {
		lines.push(
			`    const i32 __property_function_index = ${relocation.functionIndex(index)};`,
		);
	}
	if (body.some((line) => line.includes("__literal_shapes"))) {
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

	// Allocate this activation's captured-slot env (mirroring the interpreter) and
	// reassign `env` so the body's LOAD/STORE_CAPTURED(self) and CREATE_FUNCTION use
	// it, then root it in the published frame. capturesEnv implies needsRootFrame.
	if (capturesEnv) {
		lines.push(
			`    env = mal_env_new(vm, env, ${relocation.functionIndex(index)}, ${fn.capturedCount});`,
			`    __gc_frame.env = env;`,
		);
	}

	for (const line of body) {
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
	if (bodyUsesThrowExit(body)) {
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
		directEntries: [],
	};
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
	);
	if (relocatable) return canonical;
	if (canonical === null) return null;
	const variants = native.directEntries.flatMap((entry) => {
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
		);
		return emitted === null ? [] : [{ entry, emitted }];
	});
	return {
		...canonical,
		directEntries: variants.map(({ entry, emitted }) => ({
			id: entry.id,
			symbol: emitted.symbol,
			source: emitted.source,
			parameterRepresentations: entry.parameterRepresentations,
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
	);
	if (body === null) {
		return null;
	}
	if (body.some((line) => /\br-\d/.test(line))) {
		return null;
	}
	// A resume dispatch jumps directly into `body`, so any function-wide state
	// declared at its head would otherwise be skipped and read uninitialized after
	// an await/yield. Reacquire the semantic epoch on every C invocation before the
	// dispatch; register-backed JavaScript state remains in the coroutine buffer.
	const resumablePreamble: Array<string> = [];
	const watchedMethodsEpoch = body.findIndex((line) =>
		line.startsWith("u64 __watched_methods_epoch = "),
	);
	if (watchedMethodsEpoch >= 0) {
		resumablePreamble.push(...body.splice(watchedMethodsEpoch, 1));
	}

	const resumePoints = resumePointsOf(fn);
	const symbol = `mal_compiled_${index}${suffix}`;
	const lines: Array<string> = [];

	lines.push(
		`${linkage === "static" ? "static " : ""}MalValue ${symbol}(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalEnv *env, MalValue callee, void *entry_state) {`,
	);
	lines.push(`    (void) this_value;`);
	lines.push(`    (void) new_target;`);
	if (
		body.some(
			(line) =>
				line.includes("__property_ic") ||
				line.includes("__property_function_index") ||
				line.includes("__literal_shapes"),
		)
	) {
		lines.push(`    mal_vm_ensure_function_caches(vm, ${index});`);
	}
	if (body.some((line) => line.includes("__property_ic"))) {
		lines.push(`    MalInlineCache *__property_ic = vm->property_cache[${index}].sites;`);
	}
	if (body.some((line) => line.includes("__property_function_index"))) {
		lines.push(`    const i32 __property_function_index = ${index};`);
	}
	if (body.some((line) => line.includes("__literal_shapes"))) {
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

	for (const line of body) {
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
	if (bodyUsesThrowExit(body)) {
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
		directEntries: [],
	};
}

/**
 * Whether an emitted body references the shared per-function throw-exit label —
 * i.e. some fallible op outside a try/catch routed its throw to `__throw_exit`.
 * When false the label (and its epilogue) is omitted so no unused-label is emitted.
 */
function bodyUsesThrowExit(body: Array<string>): boolean {
	return body.some((line) => line.includes("__throw_exit"));
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

interface NativeIteratorResultVirtualizationAction {
	readonly region: Extract<VmRegion, { kind: "iterator-result-virtualization" }>;
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
			instruction?.opcode === "LOAD_PROPERTY_STATIC"
				? instruction.dst
				: instruction?.opcode === "STORE_PROPERTY_STATIC"
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
	readonly role: "load" | "compare" | "element";
	readonly site: Extract<VmRegion, { kind: "indexed-length-loop" }>["sites"][number];
	readonly element?: Extract<
		VmRegion,
		{ kind: "indexed-length-loop" }
	>["sites"][number]["elements"][number];
}

/**
 * Emit the instruction body, with labels at jump targets and gotos for jumps.
 * Returns null if any instruction is not yet lowerable.
 */
function emitBody(
	fn: BytecodeFunction,
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
): Array<string> | null {
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
			(action.role !== "load" && action.role !== "compare" && action.role !== "element")
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
		if (
			load?.opcode !== "LOAD_PROPERTY_STATIC" ||
			comparison?.opcode !== "BINARY" ||
			!["<", "<=", ">", ">=", "==", "!=", "===", "!=="].includes(comparison.operator) ||
			length !== load.dst ||
			(action.role === "element"
				? element === undefined ||
					(element.kind === "load"
						? elementInstruction?.opcode !== "LOAD_PROPERTY"
						: elementInstruction?.opcode !== "STORE_PROPERTY") ||
					(elementInstruction?.opcode === "LOAD_PROPERTY" ||
					elementInstruction?.opcode === "STORE_PROPERTY"
						? elementInstruction.object !== load.object ||
							elementInstruction.key !== other
						: true)
				: element !== undefined) ||
			action.ip !==
				(action.role === "load"
					? site.loadIp
					: action.role === "compare"
						? site.comparisonIp
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
		}
	}
	const jumpTargets = new Set<number>();
	for (const instruction of fn.instructions) {
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
			MATH_UNARY_NATIVE_OP.has(operation)
		) {
			mathUnaryCalls.add(ip);
		} else if (
			operation !== undefined &&
			instruction.arguments.length === 2 &&
			MATH_BINARY_NATIVE_OP.has(operation)
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
		lines.push(`u64 __watched_methods_epoch = ${watchedMethodsEpoch};`);
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
		let emitted = emitInstruction(
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
				directResultRepresentation,
				mathUnaryCall: mathUnaryCalls.has(ip),
				mathBinaryCall: mathBinaryCalls.has(ip),
				mappedArguments: fn.mappedArguments,
				mappedArgumentSlots: fn.mappedArgumentSlots,
				hasPrototype: fn.hasPrototype,
				indexedLengthLoopAction: indexedLengthLoopActionByIp.get(ip),
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
				nativeIteratorResultVirtualizationAction:
					nativeIteratorResultVirtualizationActionByIp.get(ip),
				numericFusionAction: numericFusionActionByIp.get(ip),
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
					...profileDecisionsForInstruction(fn.instructions[ip]!, ip, emitted),
				);
			}
			emitted = emitted.map((line) => {
				const boxed = instrumentProfileBoxing(line, profileSiteId);
				const fallback = operationSite
					? instrumentProfileFallback(fn.instructions[ip]!, boxed, profileSiteId)
					: boxed;
				return instrumentProfileRuntime(fallback, profileSiteId);
			});
		}
		for (const line of emitted) {
			lines.push(`    ${line}`);
		}
	}

	return lines;
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
		if (/mal_direct_\d+_\d+/.test(source)) {
			decisions.push(
				decision(`${operation}.direct-native`, "guarded", "callee-identity-guard"),
			);
		} else if (/mal_compiled_\d+/.test(source)) {
			decisions.push(
				decision(
					`${operation}.direct-compiled`,
					source.includes("mal_vm_call_direct(") ? "guarded" : "applied",
					source.includes("mal_vm_call_direct(") ? "callee-identity-guard" : undefined,
				),
			);
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
		} else if (/mal_vm_op_(load|store)_property_ic\(/.test(source)) {
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

	if (profileBoxesNativeValue(emitted)) {
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

function profileFallbackFunctions(instruction: BytecodeInstruction): Array<string> {
	const operation = profileDecisionOperation(instruction);
	if (operation === "call" || operation === "construct") {
		return operation === "construct"
			? ["mal_vm_construct_value(", "mal_vm_construct_direct("]
			: ["mal_vm_call_cached(", "mal_vm_call_direct("];
	}
	if (operation === "property") {
		return [
			"mal_vm_indexed_fast_load_index(",
			"mal_vm_indexed_fast_store_index(",
			"mal_vm_op_load_property_ic(",
			"mal_vm_op_store_property_ic(",
		];
	}
	if (operation === "allocation") {
		return [
			"mal_vm_op_create_object(",
			"mal_vm_create_object_shaped(",
			"mal_vm_op_create_array(",
		];
	}
	if (operation === "binary") return ["mal_vm_binary_op("];
	if (operation === "unary") return ["mal_vm_unary_op("];
	return [];
}

function profileBoxesNativeValue(lines: ReadonlyArray<string>): boolean {
	return lines.some(
		(line) =>
			line.includes("mal_ops_number_value(") || line.includes("mal_value_new_boolean("),
	);
}

function instrumentProfileBoxing(line: string, siteId: number): string {
	return instrumentProfileExpressions(
		line,
		["mal_ops_number_value(", "mal_value_new_boolean("],
		(value) => `MAL_PROFILE_SITE_BOX(vm, ${siteId}, ${value})`,
	);
}

function instrumentProfileFallback(
	instruction: BytecodeInstruction,
	line: string,
	siteId: number,
): string {
	return instrumentProfileExpressions(
		line,
		profileFallbackFunctions(instruction),
		(value) => `MAL_PROFILE_FALLBACK_VALUE(vm, ${siteId}, ${value})`,
	);
}

function instrumentProfileRuntime(line: string, siteId: number): string {
	const categories = [
		{
			event: "MAL_PROFILE_SITE_RUNTIME_REGEXP",
			pattern: /\bmal_regexp_[A-Za-z0-9_]+\(/gu,
		},
		{
			event: "MAL_PROFILE_SITE_RUNTIME_STRING",
			pattern: /\bmal_builtin_string_[A-Za-z0-9_]+\(/gu,
		},
	] as const;
	let output = line;
	for (const category of categories) {
		const calls = [...output.matchAll(category.pattern)].map((match) => match[0]);
		if (calls.length === 0) continue;
		output = instrumentProfileExpressions(
			output,
			[...new Set(calls)],
			(value) => `MAL_PROFILE_RUNTIME_VALUE(vm, ${siteId}, ${category.event}, ${value})`,
		);
	}
	return output;
}

function instrumentProfileExpressions(
	line: string,
	calls: ReadonlyArray<string>,
	wrap: (value: string) => string,
): string {
	let output = "";
	let cursor = 0;
	while (cursor < line.length) {
		const candidates = calls
			.map((call) => ({ call, index: line.indexOf(call, cursor) }))
			.filter((candidate) => candidate.index >= 0)
			.sort((left, right) => left.index - right.index);
		const candidate = candidates[0];
		if (candidate === undefined) break;
		let depth = 0;
		let end = -1;
		for (
			let index = candidate.index + candidate.call.length - 1;
			index < line.length;
			index++
		) {
			if (line[index] === "(") depth++;
			else if (line[index] === ")" && --depth === 0) {
				end = index;
				break;
			}
		}
		if (end < 0) break;
		output += line.slice(cursor, candidate.index);
		output += wrap(line.slice(candidate.index, end + 1));
		cursor = end + 1;
	}
	return output + line.slice(cursor);
}

/**
 * Lower a single instruction to C, or null if it isn't handled yet. Reads of a
 * `number` register use the raw double; reads where a boxed value is required
 * box it through mal_ops_number_value. Adding an opcode here (and its unboxed
 * forms) is the main way this backend grows.
 */
interface NativeInstructionContext {
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
	readonly directCompiledTargets: ReadonlySet<number>;
	readonly directCompiledEntries: DirectCompiledEntries;
	readonly directResultRepresentation?: VmRegisterRepresentation;
	readonly mathUnaryCall: boolean;
	readonly mathBinaryCall: boolean;
	readonly mappedArguments: boolean;
	readonly mappedArgumentSlots: ReadonlyArray<number>;
	readonly hasPrototype: boolean;
	readonly indexedLengthLoopAction?: IndexedLengthLoopAction;
	readonly nativeStringSplitProjectionAction?: NativeStringSplitProjectionAction;
	readonly nativeStringSplitCursorAction?: NativeStringSplitCursorAction;
	readonly nativeRegExpExecProjectionAction?: NativeRegExpExecProjectionAction;
	readonly nativeRegExpIteratorProjectionAction?: NativeRegExpIteratorProjectionAction;
	readonly nativeStringSliceNumberFusionAction?: NativeStringSliceNumberFusionAction;
	readonly nativeStringCharCodeAtChainAction?: NativeStringCharCodeAtChainAction;
	readonly nativeBuiltinCollectionCallChainAction?: NativeBuiltinCollectionCallChainAction;
	readonly nativeIteratorCursorAction?: NativeIteratorCursorAction;
	readonly nativeIteratorResultVirtualizationAction?: NativeIteratorResultVirtualizationAction;
	readonly numericFusionAction?: NativeNumericFusionAction;
	readonly relocation: NativeRelocationExpressions;
}

function nativeTypedArrayKind(
	kind: Extract<
		NativeInstructionPlan,
		{ kind: "exact-typed-array-element" }
	>["elementKind"],
): string {
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

function nativeTypedArrayElementSize(
	kind: Extract<
		NativeInstructionPlan,
		{ kind: "exact-typed-array-element" }
	>["elementKind"],
): number {
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
		nativeStringSplitProjectionAction,
		nativeStringSplitCursorAction,
		nativeRegExpExecProjectionAction,
		nativeRegExpIteratorProjectionAction,
		nativeStringSliceNumberFusionAction,
		nativeStringCharCodeAtChainAction,
		nativeBuiltinCollectionCallChainAction,
		nativeIteratorCursorAction,
		nativeIteratorResultVirtualizationAction,
		numericFusionAction,
		relocation,
	} = context;
	const genericContext: NativeInstructionContext = {
		nativePlan,
		gcSafepoint: context.gcSafepoint,
		loopBackedgeInactiveRootMask: context.loopBackedgeInactiveRootMask,
		mathCallInactiveRootMask: context.mathCallInactiveRootMask,
		tdzInactiveRootMask: context.tdzInactiveRootMask,
		knownOwnSlotLoadInactiveRootMask: context.knownOwnSlotLoadInactiveRootMask,
		staticPropertyLoadInactiveRootMask: context.staticPropertyLoadInactiveRootMask,
		directCompiledTargets,
		directCompiledEntries,
		directResultRepresentation,
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
	// Read register r as a boxed MalValue (boxing a number-rep double or a
	// boolean-rep bool).
	const boxed = (r: number): string =>
		reps[r] === "int32"
			? `mal_value_from_i32(r${r})`
			: reps[r] === "number"
				? `mal_ops_number_value(r${r})`
				: reps[r] === "boolean"
					? `mal_value_new_boolean(r${r})`
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
	const nativeNumberOperand = (operand: number): string | null => {
		const decoded = decodeVmValueOperand(operand);
		if (decoded.kind === "register") {
			return reps[decoded.register] === "int32"
				? `(f64) r${decoded.register}`
				: reps[decoded.register] === "number"
					? `r${decoded.register}`
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
			return reps[decoded.register] === "boolean" ? `r${decoded.register}` : null;
		}
		return decoded.kind === "boolean" ? (decoded.value ? "true" : "false") : null;
	};
	// Read register r as a raw double (only valid for a number-rep register).
	const num = (r: number): string => (reps[r] === "int32" ? `(f64) r${r}` : `r${r}`);
	// Read register r as a raw C bool (ToBoolean). A boolean-rep register is the
	// bool itself; a number-rep one is truthy iff nonzero and not NaN; a boxed
	// one defers to mal_value_is_truthy.
	const truthy = (r: number): string =>
		reps[r] === "boolean"
			? `r${r}`
			: reps[r] === "int32"
				? `(r${r} != 0)`
				: reps[r] === "number"
					? `(r${r} != 0.0 && r${r} == r${r})`
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
	const onThrow = handlerIp !== undefined ? `goto L${handlerIp};` : "goto __throw_exit;";
	const throwCheck = `if (vm->completion.kind == MAL_COMPLETION_THROW) ${onThrow}`;
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
		nativePlan?.kind === "exact-contained-array-element" &&
		instruction.opcode === "LOAD_PROPERTY"
	) {
		return [
			"MAL_PERF_COUNT(array_contained_element_reads);",
			reps[instruction.dst] === "number"
				? `r${instruction.dst} = mal_ops_number_as_f64(mal_array_object_contained_dense_get(mal_value_to_array_object(${boxed(instruction.object)}), ${num(instruction.key)}));`
				: `r${instruction.dst} = mal_array_object_contained_dense_get(mal_value_to_array_object(${boxed(instruction.object)}), ${num(instruction.key)});`,
		];
	}
	if (nativePlan?.kind === "exact-typed-array-element") {
		const kind = nativeTypedArrayKind(nativePlan.elementKind);
		const elementSize = nativeTypedArrayElementSize(nativePlan.elementKind);
		if (instruction.opcode === "LOAD_PROPERTY") {
			const exactLoad = `mal_vm_exact_numeric_typed_array_load(mal_value_to_typed_array_object(${boxed(instruction.object)}), mal_vm_typed_array_numeric_index(${reps[instruction.key] === "number" ? num(instruction.key) : `mal_ops_number_as_f64(${boxed(instruction.key)})`}), ${kind}, ${elementSize})`;
			if (reps[instruction.key] === "number") {
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
				`  r${instruction.dst} = mal_vm_op_load_property_ic(vm, ${boxed(instruction.object)}, ${boxed(instruction.key)}, &__property_ic[${instruction.icIndex}]);`,
				`  ${throwCheck}`,
				"}",
			];
		}
	}

	switch (instruction.opcode) {
		case "MOVE": {
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
		case "CREATE_UNDEFINED":
			return [`r${instruction.dst} = MAL_VALUE_UNDEFINED;`];
		case "CREATE_NULL":
			return [`r${instruction.dst} = MAL_VALUE_NULL;`];
		case "CREATE_EMPTY":
			// The TDZ hole sentinel. Target lowering always gives the destination a
			// boxed representation, so a number/boolean register never holds it.
			return [`r${instruction.dst} = MAL_VALUE_EMPTY;`];
		case "THROW_IF_TDZ":
			// Read-before-initialization check on a let/const/class binding. The
			// helper throws (setting the completion) only on the empty sentinel; a
			// throw propagates out, exactly like the interpreter op.
			return [
				`if (mal_value_is_empty(${boxed(instruction.src)})) {`,
				...(context.tdzInactiveRootMask === undefined
					? []
					: [`  ${cInactiveRootMaskPublication(context.tdzInactiveRootMask)};`]),
				`  mal_vm_op_throw_if_tdz(vm, ${boxed(instruction.src)}, ${relocation.stringIndex(instruction.nameStringIndex)});`,
				`  ${throwCheck}`,
				`}`,
			];
		case "IS_EMPTY":
			// Tests for the TDZ sentinel (used by default-value / with fallbacks).
			return [
				reps[instruction.dst] === "boolean"
					? `r${instruction.dst} = mal_value_is_empty(${boxed(instruction.src)});`
					: `r${instruction.dst} = mal_value_new_boolean(mal_value_is_empty(${boxed(instruction.src)}));`,
			];
		case "CREATE_BOOLEAN":
			return [
				reps[instruction.dst] === "boolean"
					? `r${instruction.dst} = ${instruction.value ? "true" : "false"};`
					: `r${instruction.dst} = mal_value_new_boolean(${instruction.value ? "true" : "false"});`,
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
				return [`r${instruction.dst} = mal_vm_op_create_object(vm);`, throwCheck];
			}
			return [
				"mal_perf_stack_object_init();",
				`${stackObjectSite.objectName} = (MalObject){ .header = MAL_HEAP_HEADER_IMMORTAL(MAL_HEAP_OBJECT), .extensible = true, .shape = mal_shape_root(&vm->heap), .prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]), .slots = nullptr, .overflow = nullptr };`,
				`r${instruction.dst} = mal_value_from_object(&${stackObjectSite.objectName});`,
			];
		case "CREATE_OBJECT_SHAPED": {
			// Build the literal's shape once in the VM-owned dense site row and
			// create the object directly in it — no per-property defines.
			const keys = instruction.keyStringIndices
				.map((ki) => `vm->string_constant_atoms[${relocation.stringIndex(ki)}]`)
				.join(", ");
			const values = instruction.valueRegisters.map((r) => boxed(r)).join(", ");
			const shape = [
				`MalShape *__oshape_${ip} = __literal_shapes[${instruction.shapeCacheIndex}];`,
				`if (__oshape_${ip} == nullptr) { __oshape_${ip} = mal_shape_from_string_keys(&vm->heap, (MalString *[]){ ${keys} }, ${instruction.count}); __literal_shapes[${instruction.shapeCacheIndex}] = __oshape_${ip}; }`,
			];
			if (stackObjectSite === undefined) {
				return [
					...shape,
					`r${instruction.dst} = mal_vm_create_object_shaped(vm, __oshape_${ip}, (MalValue[]){ ${values} }, ${instruction.count});`,
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
					`MalInlineCache *${icName} = &__property_ic[${stackObjectSite.inheritedIcIndex}];`,
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
					`  r${instruction.dst} = mal_vm_create_object_shaped(vm, __oshape_${ip}, (MalValue[]){ ${values} }, ${instruction.count});`,
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
					`r${instruction.dst} = mal_vm_op_create_array(vm, ${instruction.length});`,
					`(void) mal_vm_try_fresh_dense_indexed_fill_reserve(vm, r${instruction.dst}, ${nativePlan.length});`,
				];
			}
			return [`r${instruction.dst} = mal_vm_op_create_array(vm, ${instruction.length});`];
		case "INSTANTIATE_LITERAL_TEMPLATE":
			return [
				`r${instruction.dst} = mal_vm_instantiate_literal_template(vm, ${relocation.templateOffset(instruction.templateOffset)});`,
				throwCheck,
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
		case "DEFINE_PROPERTY":
			// Object-literal define semantics; cannot run user code, so no
			// completion check (matching the interpreter's mal_op_define_property).
			return [
				`mal_vm_op_define_property(vm, ${boxed(instruction.object)}, ${boxed(instruction.key)}, ${boxed(instruction.value)}, ${instruction.enumerable}, ${instruction.writable}, ${instruction.configurable});`,
			];
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
				throwCheck,
			];
		case "DELETE_PROPERTY":
			// `delete object[key]`; a strict-mode failed delete throws.
			return [
				`r${instruction.dst} = mal_vm_op_delete_property(vm, ${boxed(instruction.object)}, ${boxed(instruction.key)}, ${strict});`,
				throwCheck,
			];
		case "LOAD_THIS":
			// A derived constructor's `this` is in a TDZ until super() binds it, so a
			// read before then is a ReferenceError; an ordinary function's `this` is
			// always initialized and reads straight from the parameter.
			return thisSlot >= 0
				? [`r${instruction.dst} = mal_vm_op_get_this(vm, ${thisRef});`, throwCheck]
				: [`r${instruction.dst} = this_value;`];
		case "LOAD_NEW_TARGET":
			return [`r${instruction.dst} = new_target;`];
		case "GUARD_FUNCTION_INDEX":
			// Speculative-inline guard → boolean-rep dst (a raw C bool feeding the jumpIf).
			return [
				`r${instruction.dst} = mal_vm_callee_has_index(vm, ${boxed(instruction.callee)}, ${relocation.functionIndex(instruction.functionIndex)});`,
			];
		case "LOAD_CALLEE":
			// The invoked closure — used to initialize a named function expression's
			// own-name binding. Only emitted in the entry prologue, so `callee` is the
			// fresh-call parameter (a coroutine resume skips the prologue).
			return [`r${instruction.dst} = callee;`];
		case "LOAD_CAPTURED":
			return [
				`r${instruction.dst} = mal_vm_load_captured(env, ${relocation.ownerFunctionIndex(instruction.ownerFunctionIndex)}, ${instruction.index});`,
			];
		case "STORE_CAPTURED":
			return [
				`mal_vm_store_captured(env, ${relocation.ownerFunctionIndex(instruction.ownerFunctionIndex)}, ${instruction.index}, ${boxed(instruction.src)});`,
			];
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
			const candidates = instruction.candidates.flatMap((candidate) => [
				relocation.functionIndex(candidate.shapeFunctionIndex),
				candidate.shapeCacheIndex,
				candidate.slot,
			]);
			return [
				`MalValue __known_own_slot_${ip};`,
				`${relocation.enabled ? "" : "static "}const i32 __known_own_slot_candidates_${ip}[] = { ${candidates.join(", ")} };`,
				`if (mal_vm_try_load_known_own_slots(vm, ${boxed(instruction.object)}, &__property_ic[${instruction.icIndex}], ${instruction.candidates.length}, __known_own_slot_candidates_${ip}, &__known_own_slot_${ip})) {`,
				`  r${instruction.dst} = __known_own_slot_${ip};`,
				`} else {`,
				...(context.knownOwnSlotLoadInactiveRootMask === undefined
					? []
					: [
							`  ${cInactiveRootMaskPublication(context.knownOwnSlotLoadInactiveRootMask)};`,
						]),
				`  r${instruction.dst} = mal_vm_op_load_property_ic(vm, ${boxed(instruction.object)}, mal_value_from_string(vm->string_constant_atoms[${relocation.stringIndex(instruction.stringIndex)}]), &__property_ic[${instruction.icIndex}]);`,
				`  ${throwCheck}`,
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
				`  r${instruction.dst} = mal_vm_op_load_property_ic(vm, ${boxed(instruction.object)}, mal_value_from_string(vm->string_constant_atoms[${relocation.stringIndex(instruction.stringIndex)}]), &__property_ic[${instruction.icIndex}]);`,
				`  ${throwCheck}`,
				`}`,
			];
		}
		case "STORE_PROPERTY_STATIC_KNOWN_OWN_SLOT": {
			const candidates = instruction.candidates.flatMap((candidate) => [
				relocation.functionIndex(candidate.shapeFunctionIndex),
				candidate.shapeCacheIndex,
				candidate.slot,
			]);
			return [
				`${relocation.enabled ? "" : "static "}const i32 __known_own_slot_store_candidates_${ip}[] = { ${candidates.join(", ")} };`,
				`if (!mal_vm_try_store_known_own_slots(vm, ${boxed(instruction.object)}, ${boxed(instruction.value)}, &__property_ic[${instruction.icIndex}], ${instruction.candidates.length}, __known_own_slot_store_candidates_${ip})) {`,
				`  mal_vm_op_store_property_ic(vm, ${boxed(instruction.object)}, mal_value_from_string(vm->string_constant_atoms[${relocation.stringIndex(instruction.stringIndex)}]), ${boxed(instruction.value)}, ${strict}, &__property_ic[${instruction.icIndex}]);`,
				`  ${throwCheck}`,
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
				`  r${instruction.dst} = mal_vm_op_load_property_ic(vm, ${boxed(instruction.object)}, mal_value_from_string(vm->string_constant_atoms[${relocation.stringIndex(instruction.stringIndex)}]), &__property_ic[${instruction.icIndex}]);`,
				`  ${throwCheck}`,
				`}`,
			];
		}
		case "LOAD_PROPERTY":
		case "LOAD_PROPERTY_STATIC": {
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
				const capture =
					chain.methodIdentity === "authority-invariant"
						? `mal_value_is_string(${receiver})`
						: `mal_value_is_string(${receiver}) && mal_vm_local_watched_primitive_value_try_load_static(vm, __watched_methods_epoch, MAL_PRIM_KIND_STRING, &__property_ic[${instruction.icIndex}], &r${instruction.dst})`;
				return [
					`${captured} = ${capture};`,
					`if (${captured}) {`,
					...(chain.methodIdentity === "authority-invariant"
						? [`  r${instruction.dst} = MAL_VALUE_UNDEFINED;`]
						: []),
					`} else {`,
					`  r${instruction.dst} = mal_vm_op_load_property_ic(vm, ${receiver}, mal_value_from_string(vm->string_constant_atoms[${relocation.stringIndex(instruction.stringIndex)}]), &__property_ic[${instruction.icIndex}]);`,
					`  ${throwCheck}`,
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
						? `mal_builtin_string_ascii_case_chain_length_span_locked(vm, __gc_slots[${site.subjectSlot}], ${start}, ${end}, &${length})`
						: `mal_vm_local_watched_primitive_value_try_load_static(vm, __watched_methods_epoch, MAL_PRIM_KIND_STRING, &__property_ic[${instruction.icIndex}], &r${instruction.dst}) && mal_vm_local_watched_primitive_value_try_load_static(vm, __watched_methods_epoch, MAL_PRIM_KIND_STRING, &__property_ic[${load.consumer.lowerIcIndex}], &${lower}) && mal_builtin_string_ascii_case_chain_length_span(vm, r${instruction.dst}, ${lower}, __gc_slots[${site.subjectSlot}], ${start}, ${end}, &${length})`;
					return [
						...(authorityInvariant ? [] : [`MalValue ${lower};`]),
						`${fast} = __regexp_exec_${site.projection.callIp}_projected && ${start} >= 0 && ${summary};`,
						`if (!${fast}) {`,
						`  if (__regexp_exec_${site.projection.callIp}_projected && ${start} >= 0) {`,
						`    __gc_slots[${site.slotsOffset + slot}] = mal_regexp_materialize_capture_span(vm, __gc_slots[${site.subjectSlot}], ${start}, ${end});`,
						`    r${instruction.object} = __gc_slots[${site.slotsOffset + slot}];`,
						`  }`,
						`  r${instruction.dst} = mal_vm_op_load_property_ic(vm, ${boxedOperand(instruction.object)}, mal_value_from_string(vm->string_constant_atoms[${relocation.stringIndex(instruction.stringIndex)}]), &__property_ic[${instruction.icIndex}]);`,
						`  ${throwCheck}`,
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
						`  r${instruction.dst} = mal_vm_op_load_property_ic(vm, ${boxedOperand(instruction.object)}, mal_value_from_string(vm->string_constant_atoms[${relocation.stringIndex(instruction.stringIndex)}]), &__property_ic[${instruction.icIndex}]);`,
						`  ${throwCheck}`,
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
						`  r${instruction.dst} = mal_vm_op_load_property_ic(vm, ${boxedOperand(instruction.object)}, mal_value_from_string(vm->string_constant_atoms[${relocation.stringIndex(instruction.stringIndex)}]), &__property_ic[${instruction.icIndex}]);`,
						`  ${throwCheck}`,
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
						`  r${instruction.dst} = mal_vm_op_load_property_ic(vm, ${boxedOperand(instruction.object)}, ${boxedOperand(instruction.key)}, &__property_ic[${instruction.icIndex}]);`,
						`  ${throwCheck}`,
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
						`  r${instruction.dst} = mal_vm_op_load_property_ic(vm, ${boxedOperand(instruction.object)}, mal_value_from_string(vm->string_constant_atoms[${relocation.stringIndex(instruction.stringIndex)}]), &__property_ic[${instruction.icIndex}]);`,
						`  ${throwCheck}`,
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
							: ` && mal_vm_local_watched_primitive_value_try_load_static(vm, __watched_methods_epoch, MAL_PRIM_KIND_STRING, &__property_ic[${instruction.icIndex}], &r${instruction.dst})`;
					return [
						`${fast} = false;`,
						`if (__regexp_exec_${site.projection.callIp}_projected && ${start} >= 0${identityCheck}) {`,
						`  ${fast} = true;`,
						`} else {`,
						`  if (__regexp_exec_${site.projection.callIp}_projected && ${start} >= 0) {`,
						`    __gc_slots[${site.slotsOffset + slot}] = mal_regexp_materialize_capture_span(vm, __gc_slots[${site.subjectSlot}], ${start}, __regexp_exec_${site.projection.callIp}_ends[${slot}]);`,
						`    r${instruction.object} = __gc_slots[${site.slotsOffset + slot}];`,
						`  }`,
						`  r${instruction.dst} = mal_vm_op_load_property_ic(vm, ${boxedOperand(instruction.object)}, mal_value_from_string(vm->string_constant_atoms[${relocation.stringIndex(instruction.stringIndex)}]), &__property_ic[${instruction.icIndex}]);`,
						`  ${throwCheck}`,
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
						`  r${instruction.dst} = mal_vm_op_load_property_ic(vm, ${boxedOperand(instruction.object)}, ${boxedOperand(instruction.key)}, &__property_ic[${instruction.icIndex}]);`,
						`  ${throwCheck}`,
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
				const ordinary =
					reps[instruction.key] === "number"
						? [
								`MalArrayObject *${receiverName} = mal_vm_as_array(${boxed(instruction.object)});`,
								`MalValue __v_${ip};`,
								`if (${receiverName} && mal_vm_array_try_load(${receiverName}, ${num(instruction.key)}, &__v_${ip})) {`,
								`  r${instruction.dst} = __v_${ip};`,
								`} else {`,
								`  r${instruction.dst} = mal_vm_indexed_fast_load_index(vm, ${boxed(instruction.object)}, ${num(instruction.key)}, &__property_ic[${instruction.icIndex}]);`,
								`  ${throwCheck}`,
								`}`,
							]
						: [
								`r${instruction.dst} = mal_vm_indexed_fast_load(vm, ${boxed(instruction.object)}, ${boxed(instruction.key)}, &__property_ic[${instruction.icIndex}]);`,
								throwCheck,
							];
				if (
					indexedLengthLoopAction?.role === "element" &&
					indexedLengthLoopAction.element?.kind === "load"
				) {
					const id = indexedLengthLoopAction.loadIp;
					return [
						`MalValue __indexed_element_${ip};`,
						`if (__indexed_length_${id}_kind == 1 && mal_vm_array_try_load(__indexed_length_${id}_array, ${num(instruction.key)}, &__indexed_element_${ip})) {`,
						`  r${instruction.dst} = __indexed_element_${ip};`,
						`} else if (__indexed_length_${id}_kind == 2) {`,
						`  r${instruction.dst} = mal_typed_array_object_get(vm, __indexed_length_${id}_typed_array, mal_vm_typed_array_numeric_index(${num(instruction.key)}));`,
						`} else {`,
						...ordinary.map((line) => `  ${line}`),
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
								`  __string_split_cursor_${id}_trim_fast = mal_builtin_string_trim_span_direct_locked(vm, __gc_slots[${site.subjectSlot}], __string_split_cursor_${id}_start, __string_split_cursor_${id}_end, &r${instruction.dst});`,
							]
						: site.trimCalleeSlot !== undefined
							? [
									`  __string_split_cursor_${id}_trim_fast = ${semanticValidation}mal_builtin_string_trim_span_direct_licensed(vm, __gc_slots[${site.subjectSlot}], __string_split_cursor_${id}_start, __string_split_cursor_${id}_end, &r${instruction.dst});`,
								]
							: [
									`  MalValue __string_split_cursor_${id}_trim_callee;`,
									`  __string_split_cursor_${id}_trim_fast = mal_vm_local_watched_primitive_value_try_load_static(vm, __watched_methods_epoch, MAL_PRIM_KIND_STRING, &__property_ic[${site.cursor.trimIcIndex}], &__string_split_cursor_${id}_trim_callee) && mal_builtin_string_trim_span_direct(vm, __string_split_cursor_${id}_trim_callee, __gc_slots[${site.subjectSlot}], __string_split_cursor_${id}_start, __string_split_cursor_${id}_end, &r${instruction.dst});`,
								];
					return [
						`if (__string_split_cursor_${id}_active) {`,
						...trim,
						`  if (!__string_split_cursor_${id}_trim_fast) r${instruction.dst} = mal_builtin_string_split_cursor_materialize(vm, __gc_slots[${site.subjectSlot}], __string_split_cursor_${id}_start, __string_split_cursor_${id}_end);`,
						`} else {`,
						...ordinary.map((line) => `  ${line}`),
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
							...ordinary.map((line) => `  ${line}`),
							`}`,
						];
					}
				}
				return ordinary;
			}
			const probe = `mal_vm_property_try_load_static(vm, ${boxed(instruction.object)}, &__property_ic[${instruction.icIndex}], &__v_${ip})`;
			const ordinary = [
				`MalObject *${receiverName} = mal_vm_as_object(${boxed(instruction.object)});`,
				`MalValue __v_${ip};`,
				`if (${probe}) {`,
				`  r${instruction.dst} = __v_${ip};`,
				`} else {`,
				...(context.staticPropertyLoadInactiveRootMask === undefined
					? []
					: [
							`  ${cInactiveRootMaskPublication(context.staticPropertyLoadInactiveRootMask)};`,
						]),
				`  r${instruction.dst} = mal_vm_op_load_property_ic(vm, ${boxed(instruction.object)}, ${key}, &__property_ic[${instruction.icIndex}]);`,
				`  ${throwCheck}`,
				`}`,
			];
			if (indexedLengthLoopAction?.role === "load") {
				const id = indexedLengthLoopAction.loadIp;
				return [
					`__indexed_length_${id}_kind = 0;`,
					`__indexed_length_${id}_array = mal_vm_as_array(${boxed(instruction.object)});`,
					`if (__indexed_length_${id}_array != nullptr) {`,
					`  __indexed_length_${id}_kind = 1;`,
					`  __indexed_length_${id}_value = __indexed_length_${id}_array->length;`,
					`  mal_perf_ic_load_array_length_hit();`,
					`} else if (mal_vm_admit_numeric_typed_array_length(vm, ${boxed(instruction.object)}, &__indexed_length_${id}_typed_array, &__indexed_length_${id}_value)) {`,
					`  __indexed_length_${id}_kind = 2;`,
					`  r${instruction.dst} = ${reps[instruction.dst] === "number" ? `(f64) __indexed_length_${id}_value` : `mal_value_from_u32(__indexed_length_${id}_value)`};`,
					`} else {`,
					...ordinary.map((line) => `  ${line}`),
					`}`,
				];
			}
			if (nativeStringSplitCursorAction?.role === "length") {
				const { site } = nativeStringSplitCursorAction;
				const id = site.callIp;
				const index =
					reps[site.cursor.index] === "number"
						? `r${site.cursor.index}`
						: `mal_ops_number_as_f64(r${site.cursor.index})`;
				const value = `${index} + (__string_split_cursor_${id}_has ? 1.0 : 0.0)`;
				return [
					`if (__string_split_cursor_${id}_active) {`,
					`  __string_split_cursor_${id}_has = mal_builtin_string_split_cursor_next(__gc_slots[${site.subjectSlot}], __gc_slots[${site.separatorSlot}], &__string_split_cursor_${id}_state, &__string_split_cursor_${id}_start, &__string_split_cursor_${id}_end);`,
					`  r${instruction.dst} = ${reps[instruction.dst] === "number" ? value : `mal_ops_number_value(${value})`};`,
					`  if (!__string_split_cursor_${id}_has) { __gc_slots[${site.subjectSlot}] = MAL_VALUE_UNDEFINED; __gc_slots[${site.separatorSlot}] = MAL_VALUE_UNDEFINED; }`,
					`} else {`,
					...ordinary.map((line) => `  ${line}`),
					`}`,
				];
			}
			if (nativeStringSplitCursorAction?.role === "trimProperty") {
				const id = nativeStringSplitCursorAction.site.callIp;
				return [
					`if (__string_split_cursor_${id}_active && __string_split_cursor_${id}_trim_fast) {`,
					`  r${instruction.dst} = MAL_VALUE_UNDEFINED;`,
					`} else {`,
					...ordinary.map((line) => `  ${line}`),
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
						...ordinary.map((line) => `  ${line}`),
						`}`,
					];
				}
				const slot = site.elementLoads.findIndex((entry) => entry.ip === load?.ip);
				if (slot >= 0) {
					return [
						`if (${fast}) {`,
						`  r${instruction.dst} = __gc_slots[${site.slotsOffset + slot}];`,
						`} else {`,
						...ordinary.map((line) => `  ${line}`),
						`}`,
					];
				}
			}
			if (
				instruction.opcode === "LOAD_PROPERTY_STATIC" &&
				nativePlan?.kind === "primitive-string-length"
			) {
				return [
					`if (mal_value_is_string(${boxed(instruction.object)})) {`,
					`  r${instruction.dst} = mal_value_from_i32((i32) mal_string_length(mal_value_to_string(${boxed(instruction.object)})));`,
					`} else {`,
					...ordinary.map((line) => `  ${line}`),
					`}`,
				];
			}
			return ordinary;
		}
		case "STORE_PROPERTY":
		case "STORE_PROPERTY_STATIC": {
			if (stackObjectAccess !== undefined) {
				const { site, slot } = stackObjectAccess;
				return [
					`${stackObjectSlotReference(site, slot)} = ${site.scalarSlot === undefined ? boxed(instruction.value) : `r${instruction.value}`};`,
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
				const ordinary =
					reps[instruction.key] === "number"
						? [
								`MalArrayObject *${receiverName} = mal_vm_as_array(${boxed(instruction.object)});`,
								`if (!(${receiverName} && mal_vm_array_try_store(${receiverName}, ${num(instruction.key)}, ${boxed(instruction.value)}))) {`,
								`  mal_vm_indexed_fast_store_index(vm, ${boxed(instruction.object)}, ${num(instruction.key)}, ${boxed(instruction.value)}, ${strict}, &__property_ic[${instruction.icIndex}]);`,
								`  ${throwCheck}`,
								`}`,
							]
						: [
								`mal_vm_indexed_fast_store(vm, ${boxed(instruction.object)}, ${boxed(instruction.key)}, ${boxed(instruction.value)}, ${strict}, &__property_ic[${instruction.icIndex}]);`,
								throwCheck,
							];
				if (
					indexedLengthLoopAction?.role === "element" &&
					indexedLengthLoopAction.element?.kind === "store"
				) {
					const id = indexedLengthLoopAction.loadIp;
					return [
						`if (__indexed_length_${id}_kind == 1 && mal_vm_array_try_store(__indexed_length_${id}_array, ${num(instruction.key)}, ${boxed(instruction.value)})) {`,
						`} else if (__indexed_length_${id}_kind == 2) {`,
						`  mal_vm_numeric_typed_array_store_known_receiver(vm, __indexed_length_${id}_typed_array, ${num(instruction.key)}, ${boxed(instruction.value)}, ${strict});`,
						`  ${throwCheck}`,
						`} else {`,
						...ordinary.map((line) => `  ${line}`),
						`}`,
					];
				}
				return ordinary;
			}
			const probe = `${receiverName} && mal_vm_object_try_store_static(${receiverName}, ${boxed(instruction.value)}, &__property_ic[${instruction.icIndex}])`;
			return [
				`MalObject *${receiverName} = mal_vm_as_object(${boxed(instruction.object)});`,
				`if (!(${probe})) {`,
				`  mal_vm_op_store_property_ic(vm, ${boxed(instruction.object)}, ${key}, ${boxed(instruction.value)}, ${strict}, &__property_ic[${instruction.icIndex}]);`,
				`  ${throwCheck}`,
				`}`,
			];
		}
		case "TO_PROPERTY_KEY":
			return [
				`r${instruction.dst} = mal_vm_op_to_property_key(vm, ${boxed(instruction.object)}, ${boxed(instruction.key)});`,
				throwCheck,
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
				throwCheck,
			];
		case "INIT_GLOBAL_VARS":
			return [
				`mal_vm_op_init_global_vars(vm, ${instruction.nameStringIndices.length}, (const i32[]){ ${instruction.nameStringIndices.map((index) => relocation.stringIndex(index)).join(", ")} }, ${instruction.declarationConfigurable});`,
				throwCheck,
			];
		case "CREATE_ARGUMENTS_OBJECT":
			return [
				`r${instruction.dst} = mal_create_arguments_object(vm, args, arg_count, callee, env, ${mappedArguments}, ${mappedArgumentSlots.length}, ${mappedArgumentSlots.length > 0 ? `(const i32[]){ ${mappedArgumentSlots.join(", ")} }` : "nullptr"});`,
			];
		case "LOAD_ARGUMENT_COUNT":
			return [`r${instruction.dst} = mal_value_from_i32(arg_count);`];
		case "LOAD_ARGUMENT":
			return [
				`r${instruction.dst} = arg_count > ${instruction.index} ? args[${instruction.index}] : MAL_VALUE_UNDEFINED;`,
			];
		case "LOAD_STATIC_ARGUMENT": {
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
				`}`,
				throwCheck,
			];
		}
		case "CREATE_REST_ARGUMENTS":
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
				throwCheck,
			];
		case "FOR_IN_KEYS":
			// `for (k in source)`: build the enumeration key array; a proxy trap on
			// the source can throw, so propagate.
			return [
				`r${instruction.dst} = mal_for_in_keys(vm, ${boxed(instruction.source)});`,
				throwCheck,
			];
		case "LOAD_INTRINSIC":
			return [
				`r${instruction.dst} = vm->intrinsics[${emitIntrinsic(instruction.intrinsic)}];`,
			];
		case "BINARY": {
			const { dst, left, right, operator } = instruction;
			const leftIsNum = reps[left] === "int32" || reps[left] === "number";
			const rightIsNum = reps[right] === "int32" || reps[right] === "number";
			const dstIsBool = reps[dst] === "boolean";
			const compare = NATIVE_COMPARE[operator];
			const fusion = numericFusionAction;
			const exactInputKinds =
				nativePlan?.kind === "exact-binary-input-kinds"
					? nativePlan.inputKindMasks
					: undefined;
			if (indexedLengthLoopAction?.role === "compare") {
				const fallback = emitGenericInstruction();
				if (fallback === null) return null;
				const compareOperator = NATIVE_COMPARE[operator];
				if (compareOperator === undefined) return null;
				const length = `(f64) __indexed_length_${indexedLengthLoopAction.loadIp}_value`;
				const fast =
					indexedLengthLoopAction.site.lengthPosition === 1
						? `${length} ${compareOperator} ${num(right)}`
						: `${num(left)} ${compareOperator} ${length}`;
				return [
					`if (__indexed_length_${indexedLengthLoopAction.loadIp}_kind != 0) {`,
					dstIsBool
						? `  r${dst} = ${fast};`
						: `  r${dst} = mal_value_new_boolean(${fast});`,
					`} else {`,
					...fallback.map((line) => `  ${line}`),
					`}`,
				];
			}
			if (operator === "in") {
				const numberGuard = leftIsNum ? "" : `mal_ops_is_number(${boxed(left)}) && `;
				return [
					`if (${numberGuard}mal_vm_array_try_has(mal_vm_as_array(${boxed(right)}), ${leftIsNum ? num(left) : `mal_ops_number_as_f64(${boxed(left)})`})) {`,
					dstIsBool ? `  r${dst} = true;` : `  r${dst} = MAL_VALUE_TRUE;`,
					`} else {`,
					dstIsBool
						? `  r${dst} = mal_value_to_boolean(mal_vm_binary_op(vm, ${emitBinaryOperator(operator)}, ${boxed(left)}, ${boxed(right)}));`
						: `  r${dst} = mal_vm_binary_op(vm, ${emitBinaryOperator(operator)}, ${boxed(left)}, ${boxed(right)});`,
					`  ${throwCheck}`,
					`}`,
				];
			}
			if (operator === "+" && reps[left] === "string" && reps[right] === "string") {
				return [`r${dst} = mal_vm_add(vm, r${left}, r${right});`, throwCheck];
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
					const slow = `mal_vm_binary_op(vm, ${emitBinaryOperator(operator)}, ${boxed(left)}, ${boxed(right)})`;
					return [
						`__nf_${fusion.id}_ok = ${guards.length === 0 ? "true" : guards.join(" && ")};`,
						`if (__nf_${fusion.id}_ok) {`,
						`  __nf_${fusion.id}_value = ${nativeExpr};`,
						`} else {`,
						`  r${dst} = ${slow};`,
						`  ${throwCheck}`,
						`}`,
					];
				}
			}

			if (fusion?.role === "finish" && reps[fusion.first.dst] !== "number") {
				const first = fusion.first;
				const firstOnLeft = left === first.dst;
				const firstOnRight = right === first.dst;
				const firstLeftIsNum =
					reps[first.left] === "int32" || reps[first.left] === "number";
				const firstRightIsNum =
					reps[first.right] === "int32" || reps[first.right] === "number";
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
					const externalIsNum = reps[external] === "int32" || reps[external] === "number";
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
						const slow = `mal_vm_binary_op(vm, ${emitBinaryOperator(operator)}, ${boxed(left)}, ${boxed(right)})`;
						return [
							`if (${guard}) {`,
							reps[dst] === "boolean"
								? `  r${dst} = ${fast};`
								: `  r${dst} = mal_value_new_boolean(${fast});`,
							`} else {`,
							`  if (__nf_${fusion.id}_ok) r${first.dst} = mal_ops_number_value(__nf_${fusion.id}_value);`,
							reps[dst] === "boolean"
								? `  r${dst} = mal_value_to_boolean(${slow});`
								: `  r${dst} = ${slow};`,
							...(binaryOpCanThrow(operator) ? [`  ${throwCheck}`] : []),
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
									: `mal_ops_number_value(${nativeExpr})`;
						const guard = externalIsNum
							? `__nf_${fusion.id}_ok`
							: `__nf_${fusion.id}_ok && mal_ops_is_number(${boxed(external)})`;
						const slow = `mal_vm_binary_op(vm, ${emitBinaryOperator(operator)}, ${boxed(left)}, ${boxed(right)})`;
						return [
							`if (${guard}) {`,
							`  r${dst} = ${result};`,
							`} else {`,
							`  if (__nf_${fusion.id}_ok) r${first.dst} = mal_ops_number_value(__nf_${fusion.id}_value);`,
							`  r${dst} = ${slow};`,
							`  ${throwCheck}`,
							`}`,
						];
					}
				}
			}

			// The dst is `number`-rep only when the lattice proved both operands are
			// numbers in the target plan (see producesNumberFromNumbers) — emit native
			// arithmetic or a native ToInt32-based bitwise/shift/remainder, all
			// holding their integer-valued results as a double.
			if (reps[dst] === "int32") {
				if (
					!leftIsNum ||
					!rightIsNum ||
					!["&", "|", "^", "<<", ">>"].includes(operator)
				) {
					return null;
				}
				const expr = nativeNumberExpr(operator, num(left), num(right));
				return expr === null ? null : [`r${dst} = (i32) (${expr});`];
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

			const slow = `mal_vm_binary_op(vm, ${emitBinaryOperator(operator)}, ${boxed(left)}, ${boxed(right)})`;
			const completionCheck = throwCheck;
			// Store a C bool into the dst: raw for a boolean-rep register, boxed
			// otherwise. Comparisons (and the boolean cases below) flow through here.
			const storeBool = (boolExpr: string): string =>
				dstIsBool
					? `r${dst} = ${boolExpr};`
					: `r${dst} = mal_value_new_boolean(${boolExpr});`;
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
								: `  r${dst} = mal_value_new_boolean(${fastBool});`,
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
							: `r${dst} = ${numberGuard} ? mal_value_new_boolean(${fastBool}) : ${slow};`,
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
					const fast = `mal_ops_number_value(${nativeExpr})`;
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
			const proven =
				reps[src] === "int32" || reps[src] === "number"
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
					: `r${dst} = mal_value_new_boolean(${result});`,
			];
		}
		case "UNARY": {
			const { dst, src, operator } = instruction;
			if (reps[dst] === "int32") {
				if (operator !== "~" || (reps[src] !== "int32" && reps[src] !== "number")) {
					return null;
				}
				return [`r${dst} = ~mal_ops_number_to_i32(${num(src)});`];
			}
			if (reps[dst] === "number") {
				if (reps[src] !== "int32" && reps[src] !== "number") {
					return null;
				}
				// `~` is over ToInt32 (~to_i32 == bit_xor(., -1), the interpreter's
				// MAL_UNARY_BIT_NOT), its int result held as a double.
				if (operator === "~") {
					return [`r${dst} = (f64) (~mal_ops_number_to_i32(${num(src)}));`];
				}
				if (operator === "increment" || operator === "decrement") {
					if (dst === src) {
						return [`r${dst} ${operator === "increment" ? "+=" : "-="} 1.0;`];
					}
					return [`r${dst} = ${num(src)} ${operator === "increment" ? "+" : "-"} 1.0;`];
				}
				return [operator === "-" ? `r${dst} = -${num(src)};` : `r${dst} = ${num(src)};`];
			}
			// Logical not yields a boolean: !ToBoolean(src). This is exactly
			// mal_vm_unary_op(NOT) = mal_value_new_boolean(!mal_value_is_truthy(.)).
			if (operator === "!") {
				const negated = `!(${truthy(src)})`;
				return [
					reps[dst] === "boolean"
						? `r${dst} = ${negated};`
						: `r${dst} = mal_value_new_boolean(${negated});`,
				];
			}
			// A boolean-rep dst can only come from `!` (handled above).
			if (reps[dst] === "boolean") {
				return null;
			}
			const lowered = [
				`r${dst} = mal_vm_unary_op(vm, ${emitUnaryOperator(operator)}, ${boxed(src)});`,
			];
			if (THROWING_UNARY_OPERATORS.has(operator)) {
				lowered.push(throwCheck);
			}
			return lowered;
		}
		case "MATH_UNARY_NUMBER": {
			const operation = MATH_UNARY_NATIVE_OP.get(instruction.operation);
			if (operation === undefined || reps[instruction.src] !== "number") return null;
			return [
				`r${instruction.dst} = mal_builtin_math_unary_number_known(${operation}, ${num(instruction.src)});`,
			];
		}
		case "MATH_BINARY_NUMBER": {
			const operation = MATH_BINARY_NATIVE_OP.get(instruction.operation);
			if (
				operation === undefined ||
				reps[instruction.left] !== "number" ||
				reps[instruction.right] !== "number"
			) {
				return null;
			}
			return [
				`r${instruction.dst} = mal_builtin_math_binary_number_known(${operation}, ${num(instruction.left)}, ${num(instruction.right)});`,
			];
		}
		case "CALL_BUILTIN": {
			const argsExpr =
				instruction.arguments.length === 0
					? "nullptr"
					: `((MalValue[]){ ${instruction.arguments.map(boxedOperand).join(", ")} })`;
			if (instruction.operation === "Array.prototype.push") {
				return [
					`r${instruction.dst} = mal_builtin_array_push_contained(vm, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${instruction.arguments.length});`,
					throwCheck,
					poll,
				];
			}
			if (instruction.operation === "Array.prototype.pop") {
				return [
					`r${instruction.dst} = mal_builtin_array_pop_contained(vm, ${boxedOperand(instruction.thisValue)});`,
					throwCheck,
					poll,
				];
			}
			if (instruction.operation === "Object.hasOwn") {
				return [
					`r${instruction.dst} = mal_builtin_object_has_own_known(vm, ${argsExpr}, ${instruction.arguments.length});`,
					throwCheck,
					poll,
				];
			}
			if (instruction.operation === "Object.is") {
				return [
					`r${instruction.dst} = mal_builtin_object_is_known(${argsExpr}, ${instruction.arguments.length});`,
				];
			}
			if (instruction.operation === "Object.keys") {
				return [
					`r${instruction.dst} = mal_builtin_object_keys_known(vm, ${argsExpr}, ${instruction.arguments.length});`,
					throwCheck,
					poll,
				];
			}
			if (instruction.operation === "Object.values") {
				return [
					`r${instruction.dst} = mal_builtin_object_values_known(vm, ${argsExpr}, ${instruction.arguments.length});`,
					throwCheck,
					poll,
				];
			}
			if (instruction.operation === "String.prototype.charCodeAt") {
				return [
					`r${instruction.dst} = mal_builtin_string_char_code_at_known(vm, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${instruction.arguments.length});`,
					throwCheck,
					poll,
				];
			}
			if (instruction.operation === "Map.prototype.get") {
				return [
					`r${instruction.dst} = mal_builtin_map_get_known(vm, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${instruction.arguments.length});`,
					throwCheck,
					poll,
				];
			}
			if (instruction.operation === "Map.prototype.set") {
				return [
					`r${instruction.dst} = mal_builtin_map_set_known(vm, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${instruction.arguments.length});`,
					throwCheck,
					poll,
				];
			}
			if (instruction.operation === "Map.prototype.has") {
				return [
					`r${instruction.dst} = mal_builtin_map_has_known(vm, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${instruction.arguments.length});`,
					throwCheck,
					poll,
				];
			}
			if (instruction.operation === "Map.prototype.delete") {
				return [
					`r${instruction.dst} = mal_builtin_map_delete_known(vm, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${instruction.arguments.length});`,
					throwCheck,
					poll,
				];
			}
			if (instruction.operation === "Set.prototype.add") {
				return [
					`r${instruction.dst} = mal_builtin_set_add_known(vm, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${instruction.arguments.length});`,
					throwCheck,
					poll,
				];
			}
			if (instruction.operation === "Set.prototype.has") {
				return [
					`r${instruction.dst} = mal_builtin_set_has_known(vm, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${instruction.arguments.length});`,
					throwCheck,
					poll,
				];
			}
			if (instruction.operation === "Set.prototype.delete") {
				return [
					`r${instruction.dst} = mal_builtin_set_delete_known(vm, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${instruction.arguments.length});`,
					throwCheck,
					poll,
				];
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
				return [
					`r${instruction.dst} = mal_builtin_number_value_of_known(${boxedOperand(instruction.thisValue)});`,
				];
			}
			if (instruction.operation === "Boolean.prototype.valueOf") {
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
					throwCheck,
					poll,
				];
			}
			if (instruction.operation === "Date.UTC") {
				return [
					`r${instruction.dst} = mal_builtin_date_utc_known(vm, ${argsExpr}, ${instruction.arguments.length});`,
					throwCheck,
					poll,
				];
			}
			if (instruction.operation !== "String.prototype.split") return null;
			if (nativeStringSplitCursorAction?.role === "call") {
				const { site } = nativeStringSplitCursorAction;
				const id = site.callIp;
				return [
					`__string_split_cursor_${id}_active = mal_builtin_string_split_cursor_init_locked(vm, ${boxedOperand(instruction.thisValue)}, ${boxedOperand(instruction.arguments[0]!)}, &__gc_slots[${site.subjectSlot}], &__gc_slots[${site.separatorSlot}], &__string_split_cursor_${id}_state);`,
					`if (__string_split_cursor_${id}_active) {`,
					`  r${instruction.dst} = MAL_VALUE_UNDEFINED;`,
					`} else {`,
					`  r${instruction.dst} = mal_builtin_string_split_direct(vm, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${instruction.arguments.length});`,
					`}`,
					throwCheck,
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
					`${fast} = mal_builtin_string_split_projection_locked(vm, ${boxedOperand(instruction.thisValue)}, ${boxedOperand(instruction.arguments[0]!)}, (const u32[]){ ${indices} }, (MalValue *[]){ ${outputs} }, ${site.elementLoads.length}, &__string_split_${projection.callIp}_length);`,
					`if (${fast}) {`,
					`  r${instruction.dst} = MAL_VALUE_UNDEFINED;`,
					`} else {`,
					`  r${instruction.dst} = mal_builtin_string_split_direct(vm, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${instruction.arguments.length});`,
					`}`,
					throwCheck,
					poll,
				];
			}
			return [
				`r${instruction.dst} = mal_builtin_string_split_direct(vm, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${instruction.arguments.length});`,
				throwCheck,
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
			const callResult = (value: string): string =>
				reps[instruction.dst] === "int32"
					? `mal_ops_number_to_i32(mal_ops_number_as_f64(${value}))`
					: reps[instruction.dst] === "number"
						? `mal_ops_number_as_f64(${value})`
						: reps[instruction.dst] === "boolean"
							? `mal_value_to_boolean(${value})`
							: value;
			if (nativeStringCharCodeAtChainAction?.role === "call") {
				const { chain } = nativeStringCharCodeAtChainAction;
				const captured = `__string_char_code_at_${chain.callIp}_captured`;
				const boundedArgument =
					args.length === 1 ? decodeVmValueOperand(args[0]!) : undefined;
				const boundedPosition =
					callPlan?.directStringCharCodeAtPosition === "inBounds" &&
					boundedArgument?.kind === "register" &&
					reps[boundedArgument.register] === "number"
						? `r${boundedArgument.register}`
						: undefined;
				if (boundedPosition !== undefined) {
					const direct = `mal_builtin_string_char_code_at_in_bounds(${boxedOperand(instruction.thisValue)}, (usize) ${boundedPosition})`;
					return [
						`static MalCallCache __cc_${ip};`,
						`if (${captured}) {`,
						`  r${instruction.dst} = ${callResult(direct)};`,
						`} else {`,
						`  MAL_PERF_COUNT(string_char_code_at_direct_fallbacks);`,
						`  MalCompletion ${tmp} = mal_vm_call_cached(vm, &__cc_${ip}, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length});`,
						`  if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow}`,
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
						`  MalValue ${value} = mal_builtin_string_char_code_at_known(vm, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length});`,
						`  ${throwCheck}`,
						`  r${instruction.dst} = ${callResult(value)};`,
						`} else {`,
						`  MAL_PERF_COUNT(string_char_code_at_direct_fallbacks);`,
						`  MalCompletion ${tmp} = mal_vm_call_cached(vm, &__cc_${ip}, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length});`,
						`  if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow}`,
						`  r${instruction.dst} = ${callResult(`${tmp}.value`)};`,
						`}`,
						poll,
					];
				}
				return [
					`static MalCallCache __cc_${ip};`,
					`MalCompletion ${tmp};`,
					`if (${captured}) {`,
					`  ${tmp} = mal_builtin_string_char_code_at_direct(vm, &__cc_${ip}, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length});`,
					`} else {`,
					`  MAL_PERF_COUNT(string_char_code_at_direct_fallbacks);`,
					`  ${tmp} = mal_vm_call_cached(vm, &__cc_${ip}, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length});`,
					`}`,
					`if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow}`,
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
						: `mal_vm_local_watched_primitive_value_try_load_static(vm, __watched_methods_epoch, MAL_PRIM_KIND_STRING, &__property_ic[${site.cursor.trimIcIndex}], &__gc_slots[${site.trimCalleeSlot}]) && mal_builtin_string_trim_identity(vm, __gc_slots[${site.trimCalleeSlot}])`;
				const initialize = site.lockedIdentity
					? `mal_builtin_string_split_cursor_init_locked(vm, ${boxedOperand(instruction.thisValue)}, ${boxedOperand(instruction.arguments[0]!)}, &__gc_slots[${site.subjectSlot}], &__gc_slots[${site.separatorSlot}], &__string_split_cursor_${id}_state)`
					: `${admission} && ${trimIdentity} && mal_builtin_string_split_cursor_init(vm, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${boxedOperand(instruction.arguments[0]!)}, &__gc_slots[${site.subjectSlot}], &__gc_slots[${site.separatorSlot}], &__string_split_cursor_${id}_state)`;
				return [
					`static MalCallCache __cc_${ip};`,
					`__string_split_cursor_${id}_active = ${initialize};`,
					`if (__string_split_cursor_${id}_active) {`,
					`  r${instruction.dst} = MAL_VALUE_UNDEFINED;`,
					`} else {`,
					...(propertyLoad === undefined
						? []
						: [
								`  r${propertyLoad.dst} = mal_vm_op_load_property_ic(vm, ${boxedOperand(propertyLoad.object)}, mal_value_from_string(vm->string_constant_atoms[${relocation.stringIndex(propertyLoad.stringIndex)}]), &__property_ic[${propertyLoad.icIndex}]);`,
								`  ${throwCheck}`,
							]),
					`  MalCompletion ${tmp} = mal_vm_call_cached(vm, &__cc_${ip}, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length});`,
					`  if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow}`,
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
					`  MalCompletion ${tmp} = mal_vm_call_cached(vm, &__cc_${ip}, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length});`,
					`  if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow}`,
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
						`  MalCompletion ${tmp} = mal_vm_call_cached(vm, &__cc_${ip}, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length});`,
						`  if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow}`,
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
						`  MalCompletion ${tmp} = mal_vm_call_cached(vm, &__cc_${ip}, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length});`,
						`  if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow}`,
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
						`  MalCompletion ${tmp} = mal_vm_call_cached(vm, &__cc_${ip}, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length});`,
						`  if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow}`,
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
					const value = `(${end} > ${start} ? mal_value_from_i32(mal_string_code_units(mal_value_to_string(__gc_slots[${site.subjectSlot}]))[${start}]) : mal_value_new_nan())`;
					const direct =
						reps[instruction.dst] === "number"
							? `mal_ops_number_as_f64(${value})`
							: value;
					const fallbackValue =
						reps[instruction.dst] === "number"
							? `mal_ops_number_as_f64(${tmp}.value)`
							: `${tmp}.value`;
					return [
						`static MalCallCache __cc_${ip};`,
						`if (${fast}) {`,
						`  r${instruction.dst} = ${direct};`,
						`} else {`,
						`  MalCompletion ${tmp} = mal_builtin_string_char_code_at_direct(vm, &__cc_${ip}, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length});`,
						`  if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow}`,
						`  r${instruction.dst} = ${fallbackValue};`,
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
						`mal_regexp_exec_capture_projection_locked(vm, ${boxedOperand(instruction.thisValue)}, ${boxedOperand(instruction.arguments[0]!)}, (const u32[]){ ${indices} }, (MalValue *[]){ ${outputs} }, ${site.loads.length}, ${spanMask}, __regexp_exec_${projection.callIp}_starts, __regexp_exec_${projection.callIp}_ends, &__gc_slots[${site.subjectSlot}], &r${instruction.dst});`,
						throwCheck,
						`__regexp_exec_${projection.callIp}_projected = mal_value_is_boolean(r${instruction.dst});`,
						poll,
					];
				}
				const project = `mal_regexp_exec_capture_projection(vm, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${boxedOperand(instruction.arguments[0]!)}, (const u32[]){ ${indices} }, (MalValue *[]){ ${outputs} }, ${site.loads.length}, ${spanMask}, __regexp_exec_${projection.callIp}_starts, __regexp_exec_${projection.callIp}_ends, &__gc_slots[${site.subjectSlot}], &r${instruction.dst})`;
				return [
					`static MalCallCache __cc_${ip};`,
					`__regexp_exec_${projection.callIp}_projected = false;`,
					`${fast} = ${project};`,
					`if (${fast}) {`,
					`  ${throwCheck}`,
					`  __regexp_exec_${projection.callIp}_projected = mal_value_is_boolean(r${instruction.dst});`,
					`} else {`,
					`  MalCompletion ${tmp} = mal_vm_call_cached(vm, &__cc_${ip}, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length});`,
					`  if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow}`,
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
						? `mal_builtin_string_slice_to_number_direct_locked(vm, ${boxedOperand(instruction.thisValue)}, ${cF64Literal(fusion.sliceStart)}, &${value})`
						: `mal_builtin_string_slice_to_number_direct(vm, ${boxedOperand(instruction.callee)}, ${boxed(fusion.numberCallee)}, ${boxedOperand(instruction.thisValue)}, ${cF64Literal(fusion.sliceStart)}, &${value})`;
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
									`  r${propertyLoad.dst} = mal_vm_op_load_property_ic(vm, ${boxedOperand(propertyLoad.object)}, mal_value_from_string(vm->string_constant_atoms[${relocation.stringIndex(propertyLoad.stringIndex)}]), &__property_ic[${propertyLoad.icIndex}]);`,
									`  ${throwCheck}`,
								]),
						`  MalCompletion ${tmp} = mal_vm_call_cached(vm, &__cc_${ip}, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length});`,
						`  if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow}`,
						`  r${instruction.dst} = ${tmp}.value;`,
						`  ${poll}`,
						`}`,
					];
				}
				return [
					`static MalCallCache __cc_${ip};`,
					`if (${fast}) {`,
					`  r${instruction.dst} = ${reps[instruction.dst] === "number" ? value : `mal_ops_number_value(${value})`};`,
					`  ${poll}`,
					`} else {`,
					`  MalCompletion ${tmp} = mal_vm_call_cached(vm, &__cc_${ip}, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length});`,
					`  if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow}`,
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
					? `mal_builtin_string_split_projection_locked(vm, ${boxedOperand(instruction.thisValue)}, ${boxedOperand(instruction.arguments[0]!)}, (const u32[]){ ${indices} }, (MalValue *[]){ ${outputs} }, ${site.elementLoads.length}, &__string_split_${projection.callIp}_length)`
					: `mal_builtin_string_split_projection(vm, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${boxedOperand(instruction.arguments[0]!)}, (const u32[]){ ${indices} }, (MalValue *[]){ ${outputs} }, ${site.elementLoads.length}, &__string_split_${projection.callIp}_length)`;
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
								`  r${propertyLoad.dst} = mal_vm_op_load_property_ic(vm, ${boxedOperand(propertyLoad.object)}, mal_value_from_string(vm->string_constant_atoms[${relocation.stringIndex(propertyLoad.stringIndex)}]), &__property_ic[${propertyLoad.icIndex}]);`,
								`  ${throwCheck}`,
							]),
					`  MalCompletion ${tmp} = mal_vm_call_cached(vm, &__cc_${ip}, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length});`,
					`  if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow}`,
					`  r${instruction.dst} = ${tmp}.value;`,
					`  ${poll}`,
					`}`,
				];
			}
			const guardedBuiltinOperation = callPlan?.guardedBuiltinCall?.operation;
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
				const callbackTarget = callPlan?.directCallbackFunctionIndex;
				const callbackSymbol =
					callbackTarget !== undefined && directCompiledTargets.has(callbackTarget)
						? `mal_compiled_${callbackTarget}${suffix}`
						: "nullptr";
				return [
					`static MalCallCache __cc_${ip};`,
					`MalCompletion ${tmp} = mal_builtin_array_iteration_direct(vm, &__cc_${ip}, ${arrayIterationOperation}, ${callPlan?.directCallbackFunctionIndex === undefined ? -1 : relocation.functionIndex(callPlan.directCallbackFunctionIndex)}, ${callbackSymbol}, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length});`,
					`if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow}`,
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
					`if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow}`,
					`r${instruction.dst} = ${tmp}.value;`,
					poll,
				];
			}
			if (vmCallProvesBuiltin(callPlan, "Array.prototype.push")) {
				return [
					`static MalCallCache __cc_${ip};`,
					`MalCompletion ${tmp} = mal_builtin_array_push_direct(vm, &__cc_${ip}, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length}, nullptr);`,
					`if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow}`,
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
					reps[boundedArgument.register] === "number"
						? `r${boundedArgument.register}`
						: null;
				if (boundedPosition !== null) {
					return [
						`static MalCallCache __cc_${ip};`,
						`MalCompletion ${tmp} = mal_builtin_string_char_code_at_direct_in_bounds(vm, &__cc_${ip}, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length}, ${boundedPosition});`,
						`if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow}`,
						`r${instruction.dst} = ${tmp}.value;`,
						poll,
					];
				}
				return [
					`static MalCallCache __cc_${ip};`,
					`MalCompletion ${tmp} = mal_builtin_string_char_code_at_direct(vm, &__cc_${ip}, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length});`,
					`if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow}`,
					`r${instruction.dst} = ${tmp}.value;`,
					poll,
				];
			}
			if (callPlan?.directFunctionCall) {
				return [
					`static MalCallCache __cc_${ip};`,
					`MalCompletion ${tmp} = mal_vm_call_function_call_direct(vm, &__cc_${ip}, ${callPlan.directCallTargetFunctionIndex === undefined ? -1 : relocation.functionIndex(callPlan.directCallTargetFunctionIndex)}, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length});`,
					`if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow}`,
					`r${instruction.dst} = ${callResult(`${tmp}.value`)};`,
					poll,
				];
			}
			if (callPlan?.guardedFunctionIndices !== undefined) {
				const guardedCallee = `__guarded_callee_${ip}`;
				const guardedIndex = `__guarded_index_${ip}`;
				const branches = callPlan.guardedFunctionIndices.flatMap((target, index) => [
					`${index === 0 ? "if" : "else if"} (${guardedIndex} == ${relocation.functionIndex(target)}) {`,
					`  ${tmp} = mal_vm_call_exact_script(vm, ${relocation.functionIndex(target)}, ${guardedCallee}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length});`,
					`}`,
				]);
				return [
					`static MalCallCache __cc_${ip};`,
					`MalValue ${guardedCallee} = ${boxedOperand(instruction.callee)};`,
					`i32 ${guardedIndex} = mal_value_is_function_object(${guardedCallee}) ? mal_function_object_function_index(mal_value_to_function_object(${guardedCallee})) : -1;`,
					`MalCompletion ${tmp};`,
					...branches,
					`else {`,
					`  ${tmp} = mal_vm_call_cached(vm, &__cc_${ip}, ${guardedCallee}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length});`,
					`}`,
					`if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow}`,
					`r${instruction.dst} = ${callResult(`${tmp}.value`)};`,
					poll,
				];
			}
			if (callPlan?.directFunctionIndex !== undefined) {
				const target = callPlan.directFunctionIndex;
				const directEntry =
					callPlan.directEntryId === undefined
						? undefined
						: directCompiledEntries.get(
								directCompiledEntryKey(target, callPlan.directEntryId),
							);
				if (directEntry !== undefined) {
					const directCallee = `__direct_callee_${ip}`;
					const directFunction = `__direct_function_${ip}`;
					const directValue = `__direct_value_${ip}`;
					const parameters = directEntry.parameterRepresentations.map(
						(representation, parameter): string | null => {
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
						},
					);
					if (parameters.every((parameter) => parameter !== null)) {
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
										: `mal_ops_number_value(${directValue})`
									: directEntry.resultRepresentation === "boolean"
										? reps[instruction.dst] === "boolean"
											? directValue
											: `mal_value_new_boolean(${directValue})`
										: callResult(directValue);
						return [
							`MalValue ${directCallee} = ${boxedOperand(instruction.callee)};`,
							`MAL_PERF_COUNT(direct_entry_hits);`,
							`if (!mal_vm_enter_compiled(vm, ${target})) ${onThrow}`,
							`const MalFunction *${directFunction} = &vm->runtime_image->functions[${target}];`,
							`${cTypeOf(directEntry.resultRepresentation)} ${directValue} = mal_direct_${target}_${directEntry.id}${suffix}(vm, mal_vm_callee_this(vm, ${directFunction}, ${boxedOperand(instruction.thisValue)})${parameters.length === 0 ? "" : `, ${parameters.join(", ")}`}, mal_value_to_function_object(${directCallee})->creation_env, ${directCallee});`,
							`mal_vm_leave_compiled(vm);`,
							`if (vm->completion.kind == MAL_COMPLETION_THROW) ${onThrow}`,
							`r${instruction.dst} = ${directResult};`,
							poll,
						];
					}
				}
				if (directCompiledTargets.has(target)) {
					const directCallee = `__direct_callee_${ip}`;
					const directFunction = `__direct_function_${ip}`;
					const directValue = `__direct_value_${ip}`;
					return [
						`MalValue ${directCallee} = ${boxedOperand(instruction.callee)};`,
						`if (!mal_vm_enter_compiled(vm, ${target})) ${onThrow}`,
						`const MalFunction *${directFunction} = &vm->runtime_image->functions[${target}];`,
						`MalValue ${directValue} = mal_compiled_${target}${suffix}(vm, mal_vm_callee_this(vm, ${directFunction}, ${boxedOperand(instruction.thisValue)}), ${argsExpr}, ${args.length}, MAL_VALUE_UNDEFINED, mal_value_to_function_object(${directCallee})->creation_env, ${directCallee}, nullptr);`,
						`mal_vm_leave_compiled(vm);`,
						`if (vm->completion.kind == MAL_COMPLETION_THROW) ${onThrow}`,
						`r${instruction.dst} = ${callResult(directValue)};`,
						poll,
					];
				}
				return [
					`static MalCallCache __cc_${ip};`,
					`MalCompletion ${tmp} = mal_vm_call_direct(vm, &__cc_${ip}, ${relocation.functionIndex(callPlan.directFunctionIndex)}, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length});`,
					`if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow}`,
					`r${instruction.dst} = ${callResult(`${tmp}.value`)};`,
					poll,
				];
			}
			if (mathUnaryCall) {
				const argument = instruction.arguments[0]!;
				const nativeOperation = MATH_UNARY_NATIVE_OP.get(
					callPlan?.guardedBuiltinCall?.operation ?? "",
				);
				const nativeArgument = nativeNumberOperand(argument);
				if (
					reps[instruction.dst] === "number" &&
					nativeOperation !== undefined &&
					nativeArgument !== null
				) {
					return [
						`r${instruction.dst} = mal_builtin_math_unary_number_known(${nativeOperation}, ${nativeArgument});`,
						mathPoll,
					];
				}
				return [
					`static MalMathUnaryOp __math_${ip};`,
					`MalValue __math_result_${ip};`,
					`if (mal_builtin_math_unary_fast(${boxedOperand(instruction.callee)}, &__math_${ip}, ${boxedOperand(argument)}, &__math_result_${ip})) {`,
					`  r${instruction.dst} = __math_result_${ip};`,
					`} else {`,
					...mathFallbackRootPublication,
					`  static MalCallCache __cc_${ip};`,
					`  MalCompletion ${tmp} = mal_vm_call_cached(vm, &__cc_${ip}, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length});`,
					`  if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow}`,
					`  r${instruction.dst} = ${tmp}.value;`,
					`}`,
					mathPoll,
				];
			}
			if (mathBinaryCall) {
				const left = instruction.arguments[0]!;
				const right = instruction.arguments[1]!;
				const nativeOperation = MATH_BINARY_NATIVE_OP.get(
					callPlan?.guardedBuiltinCall?.operation ?? "",
				);
				const nativeLeft = nativeNumberOperand(left);
				const nativeRight = nativeNumberOperand(right);
				if (
					reps[instruction.dst] === "number" &&
					nativeOperation !== undefined &&
					nativeLeft !== null &&
					nativeRight !== null
				) {
					return [
						`r${instruction.dst} = mal_builtin_math_binary_number_known(${nativeOperation}, ${nativeLeft}, ${nativeRight});`,
						mathPoll,
					];
				}
				return [
					`static MalMathBinaryOp __math_${ip};`,
					`MalValue __math_result_${ip};`,
					`if (mal_builtin_math_binary_fast(${boxedOperand(instruction.callee)}, &__math_${ip}, ${boxedOperand(left)}, ${boxedOperand(right)}, &__math_result_${ip})) {`,
					`  r${instruction.dst} = __math_result_${ip};`,
					`} else {`,
					...mathFallbackRootPublication,
					`  static MalCallCache __cc_${ip};`,
					`  MalCompletion ${tmp} = mal_vm_call_cached(vm, &__cc_${ip}, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length});`,
					`  if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow}`,
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
				`MalCompletion ${tmp} = mal_vm_call_cached(vm, &__cc_${ip}, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length});`,
				`if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow}`,
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
					? `mal_vm_construct_value(vm, ${boxedOperand(instruction.callee)}, ${argsExpr}, ${args.length})`
					: `mal_vm_construct_direct(vm, ${relocation.functionIndex(constructPlan.directFunctionIndex)}, ${boxedOperand(instruction.callee)}, ${argsExpr}, ${args.length})`;
			return [
				`MalCompletion ${tmp} = ${construct};`,
				`if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow}`,
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
				onThrow,
			];
		case "LOAD_UNDECLARED":
			// An undeclared reference always throws ReferenceError; the helper sets
			// the throw completion, so route it to the handler / out of the frame.
			return [
				`mal_vm_op_load_undeclared(vm, ${relocation.stringIndex(instruction.nameStringIndex)});`,
				onThrow,
			];
		case "TRY_BEGIN":
		case "TRY_END":
			// Markers only: the protected range becomes the per-instruction handler
			// target computed in emitBody (the `onThrow` goto), so no code is needed.
			return [];
		case "CATCH":
			// Handler entry: bind the pending thrown value and clear the completion,
			// exactly as mal_op_catch does. The dst is boxed (any value can be caught).
			return [
				`r${instruction.dst} = vm->completion.value;`,
				`vm->completion = (MalCompletion) { .kind = MAL_COMPLETION_NORMAL, .value = MAL_VALUE_UNDEFINED };`,
			];
		case "REQUIRE_COERCIBLE":
			// Destructuring / member-base coercibility: null or undefined throws.
			return [`mal_vm_op_require_coercible(vm, ${boxed(instruction.src)});`, throwCheck];
		case "GET_ITERATOR": {
			const rec = `iter_rec_${ip}`;
			const lines = [
				`MalIteratorRecord ${rec};`,
				`if (!mal_vm_get_iterator(vm, ${boxed(instruction.source)}, &${rec})) ${onThrow}`,
				`r${instruction.iteratorDst} = ${rec}.iterator;`,
				`r${instruction.nextDst} = ${rec}.next_method;`,
			];
			if (nativeIteratorCursorAction?.role === "initialize") {
				const { cursor } = nativeIteratorCursorAction;
				lines.push(
					`__iter_cursor_${cursor.initializeIp} = mal_vm_iterator_protocol_cursor(&${rec}, ${nativeIteratorCursorProtocol(cursor)});`,
				);
			}
			return lines;
		}
		case "GET_ASYNC_ITERATOR": {
			// GetIterator(source, async): fetch @@asyncIterator (falling back to a
			// sync iterator wrapped as async). A missing/throwing method propagates.
			const rec = `aiter_rec_${ip}`;
			return [
				`MalIteratorRecord ${rec};`,
				`if (!mal_vm_get_async_iterator(vm, ${boxed(instruction.source)}, &${rec})) ${onThrow}`,
				`r${instruction.iteratorDst} = ${rec}.iterator;`,
				`r${instruction.nextDst} = ${rec}.next_method;`,
			];
		}
		case "ITERATOR_STEP": {
			const rec = `iter_rec_${ip}`;
			const val = `iter_val_${ip}`;
			const done = `iter_done_${ip}`;
			const virtualResult = nativeIteratorResultVirtualizationAction !== undefined;
			if (virtualResult) {
				regionAdmissionGuard(nativeIteratorResultVirtualizationAction.region.license);
			}
			const genericStep = virtualResult
				? `mal_vm_iterator_step_fast(vm, &${rec}, &${val}, &${done})`
				: `mal_vm_iterator_step(vm, &${rec}, &${val}, &${done})`;
			const step =
				nativeIteratorCursorAction?.role === "step"
					? `(__iter_cursor_${nativeIteratorCursorAction.cursor.initializeIp} != nullptr ? mal_vm_iterator_step_protocol_cursor(vm, __iter_cursor_${nativeIteratorCursorAction.cursor.initializeIp}, &${val}, &${done}) : ${genericStep})`
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
					`int ${status} = ${admission} ? mal_regexp_try_exact_iterator_capture_projection(vm, ${boxed(instruction.iterator)}, ${boxed(instruction.next)}, (const u32[]){ ${indices} }, (MalValue *[]){ ${outputs} }, ${site.loads.length}, __regexp_iter_${site.projection.stepIp}_starts, __regexp_iter_${site.projection.stepIp}_ends, &__gc_slots[${site.subjectSlot}], &${val}, &${done}) : 0;`,
					`if (${status} < 0) ${onThrow}`,
					`if (${status} == 0 && !(${step})) ${onThrow}`,
					`__regexp_iter_${site.projection.stepIp}_projected = ${status} > 0 && mal_value_is_boolean(${val});`,
					`r${instruction.valueDst} = ${val};`,
					reps[instruction.doneDst] === "boolean"
						? `r${instruction.doneDst} = ${done};`
						: `r${instruction.doneDst} = mal_value_new_boolean(${done});`,
				];
			}
			return [
				`MalIteratorRecord ${rec} = { .iterator = ${boxed(instruction.iterator)}, .next_method = ${boxed(instruction.next)} };`,
				`MalValue ${val}; bool ${done};`,
				`if (!(${step})) ${onThrow}`,
				`r${instruction.valueDst} = ${val};`,
				reps[instruction.doneDst] === "boolean"
					? `r${instruction.doneDst} = ${done};`
					: `r${instruction.doneDst} = mal_value_new_boolean(${done});`,
			];
		}
		case "ITERATOR_CLOSE": {
			const rec = `iter_rec_${ip}`;
			if (instruction.normal) {
				// Normal-completion close: propagate return()'s throw and TypeError
				// on a non-object result.
				return [
					`MalIteratorRecord ${rec} = { .iterator = ${boxed(instruction.iterator)}, .next_method = MAL_VALUE_UNDEFINED };`,
					`if (!mal_vm_iterator_close_normal(vm, &${rec})) ${onThrow}`,
				];
			}
			return [
				`MalIteratorRecord ${rec} = { .iterator = ${boxed(instruction.iterator)}, .next_method = MAL_VALUE_UNDEFINED };`,
				`mal_vm_iterator_close(vm, &${rec});`,
				throwCheck,
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
					throwCheck,
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
					throwCheck,
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
				`${gcUnlink}return mal_ops_construct_result(${value}, this_value, new_target);`,
			];
		}
		case "LOAD_GLOBAL_PROPERTY":
			// Sloppy-mode read of an unresolved name off globalThis; a missing name
			// throws ReferenceError and a global getter can throw, so propagate.
			return [
				`r${instruction.dst} = mal_vm_op_load_global_property(vm, ${relocation.stringIndex(instruction.nameStringIndex)});`,
				throwCheck,
			];
		case "LOAD_PROTOTYPE":
			// Reads the internal [[Prototype]] slot directly (no proxy trap) — never throws.
			return [
				`r${instruction.dst} = mal_vm_op_load_prototype(vm, ${boxed(instruction.object)});`,
			];
		case "LOAD_SUPER_PROPERTY":
			return [
				`r${instruction.dst} = mal_vm_op_load_super_property(vm, ${boxed(instruction.object)}, ${boxed(instruction.key)}, ${boxed(instruction.receiver)});`,
				throwCheck,
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
				`if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow}`,
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
				`r${instruction.dst} = mal_vm_op_create_module_namespace(vm, ${count}, ${names}, ${slots});`,
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
				throwCheck,
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
				throwCheck,
			];
		case "INIT_PRIVATE_FIELDS":
			return [
				`mal_vm_op_init_private_fields(vm, ${boxed(instruction.object)}, ${instruction.keyRegisters.length}, (const MalValue[]){ ${instruction.keyRegisters.map((key) => boxed(key)).join(", ")} });`,
				throwCheck,
			];
		case "LOAD_PRIVATE":
			// PrivateGet; an unbranded receiver throws.
			return [
				`r${instruction.dst} = mal_vm_op_load_private(vm, ${boxed(instruction.object)}, ${boxed(instruction.key)});`,
				throwCheck,
			];
		case "STORE_PRIVATE":
			// PrivateSet; the name must already be installed, else throws.
			return [
				`mal_vm_op_store_private(vm, ${boxed(instruction.object)}, ${boxed(instruction.key)}, ${boxed(instruction.value)});`,
				throwCheck,
			];
		case "HAS_PRIVATE":
			// Ergonomic brand check `#x in obj`; a non-object receiver throws.
			return [
				reps[instruction.dst] === "boolean"
					? `r${instruction.dst} = mal_value_to_boolean(mal_vm_op_has_private(vm, ${boxed(instruction.object)}, ${boxed(instruction.key)}));`
					: `r${instruction.dst} = mal_vm_op_has_private(vm, ${boxed(instruction.object)}, ${boxed(instruction.key)});`,
				throwCheck,
			];
		case "CALL_SPREAD": {
			// `f(...args)`: marshal the spread array and dispatch, mirroring CALL.
			const tmp = `call_spread_${ip}`;
			return [
				`MalCompletion ${tmp} = mal_vm_op_call_spread(vm, ${boxed(instruction.callee)}, ${boxed(instruction.thisValue)}, ${boxed(instruction.argumentsArray)});`,
				`if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow}`,
				`r${instruction.dst} = ${tmp}.value;`,
				poll, // call-return safepoint
			];
		}
		case "CALL_SPREAD_ITERABLE": {
			// `f(...iterable)` with no other arguments: observe GetIterator,
			// then let the runtime use its guarded dense-Array path.
			const tmp = `call_spread_iterable_${ip}`;
			return [
				`MalCompletion ${tmp} = mal_vm_op_call_spread_iterable(vm, ${boxed(instruction.callee)}, ${boxed(instruction.thisValue)}, ${boxed(instruction.iterable)});`,
				`if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow}`,
				`r${instruction.dst} = ${tmp}.value;`,
				poll, // call-return safepoint
			];
		}
		case "CONSTRUCT_SPREAD": {
			// `new C(...args)`: marshal the spread array and dispatch, mirroring CONSTRUCT.
			const tmp = `construct_spread_${ip}`;
			return [
				`MalCompletion ${tmp} = mal_vm_op_construct_spread(vm, ${boxed(instruction.callee)}, ${boxed(instruction.argumentsArray)});`,
				`if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow}`,
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
				throwCheck,
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
				throwCheck,
			];
		case "WITH_RESOLVE_BASE":
			// The reference base (the with-object itself) for a read/write through it.
			return [
				`r${instruction.dst} = mal_vm_op_with_resolve_base(vm, env, ${relocation.stringIndex(instruction.nameStringIndex)});`,
				throwCheck,
			];
		case "WITH_SET":
			// Assign through the with-envs; `found` (always boxed-rep) reports whether a
			// binding matched so the IR can fall back to the static binding on a miss.
			return [
				`r${instruction.found} = mal_value_new_boolean(mal_vm_op_with_set(vm, env, ${relocation.stringIndex(instruction.nameStringIndex)}, ${boxed(instruction.value)}));`,
				throwCheck,
			];
		case "CHECK_SUPER_CLASS":
			// ClassDefinitionEvaluation heritage check; a bad `extends` value throws.
			return [
				`mal_vm_op_check_super_class(vm, ${boxed(instruction.parent)});`,
				throwCheck,
			];
		case "STORE_SUPER_PROPERTY":
			// `super.p = v`: the base descriptor governs, the write hits `receiver`.
			// A setter or a strict-mode rejection throws.
			return [
				`mal_vm_op_store_super_property(vm, ${boxed(instruction.object)}, ${boxed(instruction.key)}, ${boxed(instruction.value)}, ${boxed(instruction.receiver)}, ${strict});`,
				throwCheck,
			];
		case "CONSTRUCT_SUPER": {
			// `super(...args)`: construct the parent, bind the result as this activation's
			// (rooted, mutable) `this`, and yield it. Only appears in derived
			// constructors, so `thisRef` is always the rooted this-slot.
			const tmp = `construct_super_${ip}`;
			return [
				`MalCompletion ${tmp} = mal_vm_op_construct_super(vm, ${boxed(instruction.parent)}, ${boxed(instruction.argumentsArray)}, new_target, ${thisRef}, &${thisRef});`,
				`if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow}`,
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
				`if (${completion}.kind == MAL_COMPLETION_THROW) ${onThrow}`,
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
