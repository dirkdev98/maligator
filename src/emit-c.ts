import { builtinOperationDescriptor } from "./builtin-registry.ts";
import type { MathUnaryOperationKey } from "./builtin-registry.ts";
import {
	emitBinaryOperator,
	emitIntrinsic,
	emitTypeofResult,
	emitUnaryOperator,
} from "./emit-vm.ts";
import { NUMERIC_HOF_INPUT_ACCUMULATOR, NUMERIC_HOF_INPUT_ELEMENT } from "./ir.ts";
import {
	computeArgumentRetentionLimit,
	decodeVmValueOperand,
	vmCallProvesBuiltin,
	vmGuardIsWorldInvariant,
	vmRegionLicense,
	vmSemanticProtectorGuard,
} from "./lower-vm.ts";
import type {
	VmExceptionHandler,
	VmFunction,
	VmGuardPlan,
	VmInstruction,
	VmRegionLicense,
	VmSemanticDependency,
	VmSemanticProtectorFact,
} from "./lower-vm.ts";
import { profileOperationForInstruction } from "./profile-metadata.ts";

/**
 * The native-C backend: lower an eligible function straight to a C function
 * (no VM dispatch loop), installed as MalFunction.compiled. Only a subset of
 * opcodes is lowered; anything else makes a function ineligible (it falls back
 * to the interpreter).
 *
 * VALUE REPRESENTATION & UNBOXING: each register has a `RegisterRep`. A register
 * that a static forward analysis (inferReps) proves *always* holds a JS number —
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
 * values of different reps joins to `boxed` (see inferReps).
 */
type RegisterRep = "boxed" | "number" | "boolean";

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
	/** Fully promoted leading numeric parameters eligible for a register ABI. */
	nativeNumberArgumentCount: number;
	/** Exact targets this body actually invokes through their numeric entry. */
	nativeNumberCallTargets: ReadonlySet<number>;
	/** Final decisions from the exact emitted variant, never an exploratory pass. */
	profileDecisions: Array<BackendProfileDecision>;
	/**
	 * The full `static MalValue ...(...) { ... }` definition — plus, for a function
	 * that speculatively unboxes params, its fully-boxed fallback variant emitted
	 * ahead of it (the entry guard jumps there instead of the interpreter).
	 */
	source: string;
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
 * The resume points of a coroutine — the instruction after each suspend
 * (GENERATOR_START/YIELD/AWAIT), where a resume re-enters. The instruction pointer
 * is advanced past the suspend before the frame is saved, so the resume IP is the
 * following instruction.
 */
function resumePointsOf(fn: VmFunction): Array<number> {
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
const NATIVE_ARITH: Record<string, string> = { "+": "+", "-": "-", "*": "*", "/": "/" };
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

/**
 * Binary operators whose operands are unambiguously numeric, so using a
 * parameter as one is strong evidence the parameter is meant to be a number and
 * justifies promoting it to `number`-rep (and hoisting an entry guard). `+` and
 * the equality operators are deliberately excluded: `+` is also string
 * concatenation and equality accepts any type, so a parameter used only there
 * is left boxed to avoid an entry guard that would bail on ordinary non-numeric
 * callers.
 */
const UNAMBIGUOUS_NUMERIC_BINARY = new Set<string>([
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
	"<",
	"<=",
	">",
	">=",
]);

/**
 * PARAM-ENTRY UNBOXING: the parameter registers eligible for speculative
 * number-rep promotion. A parameter qualifies when every read of it is
 * numeric-friendly — at least one unambiguously-numeric use (so promotion
 * actually pays; a parameter only boxed at a boundary gains nothing) and no use
 * that strongly implies a non-number (a property base/key, a callee/receiver, a
 * generic type query like `!`/unfused typeof, or `in`/`instanceof`). A fused
 * TYPEOF_COMPARE is neutral: the numeric version's entry guard makes its result
 * statically known, while the boxed version retains the source predicate.
 *
 * Promotion is *speculative*, not a proof: a promoted parameter is unboxed once
 * at function entry behind a guard that bails to the interpreter when an
 * argument is not actually a number (see emitCompiledFunction), so the fast
 * body then runs fully unboxed with no per-op guards. Correctness therefore
 * does not depend on this scan — it only governs profitability and how often
 * the guard bails. A parameter reassigned to a non-number is separately demoted
 * to boxed by inferReps, so the entry guard only covers parameters that both
 * qualify here and survive as number-rep.
 *
 * Returns the empty set if the function contains an opcode the backend doesn't
 * lower: it won't compile, so promotion is moot, and this avoids classifying
 * register reads the scan doesn't model.
 */
function numericParamCandidates(fn: VmFunction): Set<number> {
	const paramCount = fn.parameterCount;
	if (paramCount === 0) {
		return new Set();
	}

	// Record the use *at each instruction*, rather than globally by physical
	// register. Allocation deliberately reuses a color after a value dies; a
	// global register graph then lets a later unrelated object use poison an
	// earlier numeric parameter. The dataflow below follows the parameter value
	// through MOVEs and kills its provenance on every physical-register rewrite.
	const numericReads: Array<Array<number>> = fn.instructions.map(() => []);
	const disqualifyingReads: Array<Array<number>> = fn.instructions.map(() => []);
	let legacyUnsupported = false;

	for (let ip = 0; ip < fn.instructions.length; ip++) {
		const instruction = fn.instructions[ip]!;
		if (
			instruction.opcode === "CREATE_OBJECT_SHAPED" ||
			instruction.opcode === "LOAD_GLOBAL_PROPERTY" ||
			instruction.opcode === "STORE_GLOBAL_PROPERTY" ||
			instruction.opcode === "INIT_GLOBAL_VARS" ||
			instruction.opcode === "THROW_IF_TDZ"
		) {
			// The former global-register classifier rejected these opcodes. Preserve
			// that admission policy except for a parameter explicitly participating
			// in the guarded finite-construction region below.
			legacyUnsupported = true;
		}
		const numeric = numericReads[ip]!;
		const disqualifying = disqualifyingReads[ip]!;
		switch (instruction.opcode) {
			case "MOVE":
				break;
			// No register reads, or a neutral boundary read (the value is boxed
			// there regardless) that neither justifies nor disqualifies promotion.
			case "CREATE_UNDEFINED":
			case "CREATE_NULL":
			case "CREATE_BOOLEAN":
			case "CREATE_NUMBER":
			case "CREATE_F64":
			case "CREATE_STRING":
			case "CREATE_BIGINT":
			case "CREATE_OBJECT":
			case "CREATE_OBJECT_SHAPED": // value registers are boxed boundaries
			case "CREATE_ARRAY":
			case "INSTANTIATE_LITERAL_TEMPLATE":
			case "CREATE_FUNCTION":
			case "CREATE_ARGUMENTS_OBJECT": // reads the raw args, no register operand
			case "LOAD_ARGUMENT_COUNT": // reads arg_count, no register operand
			case "LOAD_ARGUMENT": // reads the raw args, no register operand
			case "LOAD_STATIC_ARGUMENT": // register reads are boxed boundaries
			case "CREATE_REST_ARGUMENTS": // reads the raw args, no register operand
			case "DEFINE_PROPERTY": // object is the literal; key/value boxed boundary reads
			case "LOAD_THIS":
			case "LOAD_NEW_TARGET":
			case "LOAD_UNDECLARED":
			case "LOAD_GLOBAL_PROPERTY": // no register operand
			case "LOAD_CAPTURED":
			case "LOAD_GLOBAL":
			case "LOAD_INTRINSIC":
			case "STORE_GLOBAL": // src boxed at the global-store boundary
			case "STORE_GLOBAL_PROPERTY": // src boxed at the global-property boundary
			case "STORE_CAPTURED": // src boxed into the captured slot
			case "INIT_GLOBAL_VARS": // no register operand
			case "THROW_IF_TDZ": // a promoted Number cannot be EMPTY
			case "THROW": // value boxed at the throw boundary
			case "JUMP":
			case "JUMP_IF": // cond read via native truthiness — fine for a number
			case "RETURN": // value boxed at return
				break;
			case "CONSTRUCT":
				disqualifying.push(instruction.callee);
				// arguments are neutral boundary reads
				break;
			case "LOAD_PROPERTY":
			case "LOAD_SUPER_PROPERTY":
				disqualifying.push(instruction.object);
				// A numeric key enables the dense-array index path. Non-number callers
				// take the boxed entry fallback before any body effects.
				numeric.push(instruction.key);
				if (instruction.opcode === "LOAD_SUPER_PROPERTY") {
					disqualifying.push(instruction.receiver);
				}
				break;
			case "LOAD_PROPERTY_STATIC":
				disqualifying.push(instruction.object);
				break;
			case "STORE_PROPERTY":
				disqualifying.push(instruction.object);
				numeric.push(instruction.key);
				// value is a neutral boundary read
				break;
			case "STORE_PROPERTY_STATIC":
				disqualifying.push(instruction.object);
				break;
			case "TO_PROPERTY_KEY":
				// object and key are read as boxed values, never numerically.
				disqualifying.push(instruction.object, instruction.key);
				break;
			case "FOR_IN_KEYS":
				// source is enumerated as an object, never read numerically.
				disqualifying.push(instruction.source);
				break;
			case "ARRAY_REST":
				// src is read as an array-like, never numerically.
				disqualifying.push(instruction.src);
				break;
			case "CALL":
				disqualifying.push(instruction.callee, instruction.thisValue);
				// arguments are neutral boundary reads
				break;
			case "CALL_BUILTIN":
				disqualifying.push(instruction.thisValue);
				// arguments are neutral boxed boundary reads
				break;
			case "MATH_UNARY_NUMBER":
				numeric.push(instruction.src);
				break;
			case "MATH_BINARY_NUMBER":
				numeric.push(instruction.left, instruction.right);
				break;
			case "BINARY":
				if (instruction.operator === "in" || instruction.operator === "instanceof") {
					disqualifying.push(instruction.left, instruction.right);
				} else if (UNAMBIGUOUS_NUMERIC_BINARY.has(instruction.operator)) {
					numeric.push(instruction.left, instruction.right);
				}
				// `+` and the equality operators are neutral
				break;
			case "UNARY":
				if (
					instruction.operator === "-" ||
					instruction.operator === "+" ||
					instruction.operator === "~" ||
					instruction.operator === "tonumeric" ||
					instruction.operator === "increment" ||
					instruction.operator === "decrement"
				) {
					numeric.push(instruction.src);
				} else {
					// !, typeof, void, delete — not numeric
					disqualifying.push(instruction.src);
				}
				break;
			case "TYPEOF_COMPARE":
				// A canonical source-level type predicate is compatible with a numeric
				// specialization. It does not justify promotion by itself (a separate
				// numeric use must still pay for the version), but it no longer blocks
				// that specialization; TYPEOF_COMPARE emission folds it from the proven
				// representation in the fast version.
				break;
			default:
				// An opcode the backend can't lower yet: the function won't compile.
				return new Set();
		}
	}

	// Preserve the former physical-register admission policy for every ordinary
	// function. The flow-sensitive extension below is deliberately additive only
	// for parameters that are already runtime guards of a finite construction.
	const legacyPromotable = new Set<number>();
	if (!legacyUnsupported) {
		const numericUse = new Set(numericReads.flat());
		const disqualifyingUse = new Set(disqualifyingReads.flat());
		const moveTargets = new Map<number, Array<number>>();
		for (const instruction of fn.instructions) {
			if (instruction.opcode !== "MOVE") continue;
			const targets = moveTargets.get(instruction.src) ?? [];
			targets.push(instruction.dst);
			moveTargets.set(instruction.src, targets);
		}
		for (let p = 0; p < paramCount; p++) {
			const seen = new Set<number>([p]);
			const stack = [p];
			let justified = false;
			let disqualified = false;
			while (stack.length > 0) {
				const register = stack.pop()!;
				if (disqualifyingUse.has(register)) {
					disqualified = true;
					break;
				}
				justified ||= numericUse.has(register);
				for (const target of moveTargets.get(register) ?? []) {
					if (!seen.has(target)) {
						seen.add(target);
						stack.push(target);
					}
				}
			}
			if (justified && !disqualified) legacyPromotable.add(p);
		}
	}

	// Exception edges would need their own predecessor states. Declining the new
	// region-derived promotion preserves the legacy result for such functions.
	if (fn.handlers.length > 0 || fn.instructions.length === 0) return legacyPromotable;

	type ParamState = Map<number, bigint>;
	const entryStates: Array<ParamState | undefined> = Array.from(
		{ length: fn.instructions.length },
		() => undefined,
	);
	const entry = new Map<number, bigint>();
	for (let p = 0; p < paramCount; p++) entry.set(p, 1n << BigInt(p));
	entryStates[0] = entry;
	const worklist = [0];
	const queued = new Set(worklist);
	let numericMask = 0n;
	let disqualifyingMask = 0n;
	let finiteConstructionMask = 0n;

	const enqueueMerge = (target: number, incoming: ParamState): void => {
		if (target < 0 || target >= fn.instructions.length) return;
		const current = entryStates[target];
		if (current === undefined) {
			entryStates[target] = new Map(incoming);
			if (!queued.has(target)) {
				queued.add(target);
				worklist.push(target);
			}
			return;
		}
		let changed = false;
		for (const [register, mask] of incoming) {
			const merged = (current.get(register) ?? 0n) | mask;
			if (merged !== current.get(register)) {
				current.set(register, merged);
				changed = true;
			}
		}
		if (changed && !queued.has(target)) {
			queued.add(target);
			worklist.push(target);
		}
	};

	while (worklist.length > 0) {
		const ip = worklist.shift()!;
		queued.delete(ip);
		const state = entryStates[ip]!;
		for (const register of numericReads[ip]!) {
			numericMask |= state.get(register) ?? 0n;
		}
		for (const register of disqualifyingReads[ip]!) {
			disqualifyingMask |= state.get(register) ?? 0n;
		}

		const instruction = fn.instructions[ip]!;
		if (instruction.opcode === "CREATE_OBJECT") {
			for (const register of instruction.nativeFiniteConstruction?.numberGuards ?? []) {
				finiteConstructionMask |= state.get(register) ?? 0n;
			}
		}
		const outgoing = new Map(state);
		const moveMask =
			instruction.opcode === "MOVE" ? (state.get(instruction.src) ?? 0n) : 0n;
		for (const register of writeRegisters(instruction)) outgoing.delete(register);
		if (instruction.opcode === "MOVE" && moveMask !== 0n) {
			outgoing.set(instruction.dst, moveMask);
		}

		if (instruction.opcode === "JUMP") {
			enqueueMerge(instruction.targetIp, outgoing);
		} else if (instruction.opcode === "JUMP_IF") {
			enqueueMerge(instruction.targetIp, outgoing);
			enqueueMerge(ip + 1, outgoing);
		} else if (instruction.opcode !== "RETURN" && instruction.opcode !== "THROW") {
			enqueueMerge(ip + 1, outgoing);
		}
	}

	const promotable = new Set(legacyPromotable);
	for (let p = 0; p < paramCount; p++) {
		const bit = 1n << BigInt(p);
		if (
			(finiteConstructionMask & bit) !== 0n &&
			(numericMask & bit) !== 0n &&
			(disqualifyingMask & bit) === 0n
		) {
			promotable.add(p);
		}
	}
	return promotable;
}

/**
 * Emit a compiled C function for `fn`, or null when it uses a construct the
 * backend doesn't lower yet (the caller then leaves it to the interpreter).
 */
export function emitCompiledFunction(
	fn: VmFunction,
	index: number,
	suffix: string,
	debug: boolean,
	// Set when emitting the boxed fallback variant (see below): a fixed symbol and
	// an empty promotable set (no speculation, no guard, no further fallback).
	override?: { symbol: string; promotable: Set<number> },
	linkage: "static" | "external" = "static",
	directCompiledTargets: ReadonlyMap<number, number> = new Map(),
	semanticProtectors: ReadonlyArray<VmSemanticProtectorFact> = [],
): CompiledFunction | null {
	// Generators and async functions suspend mid-body: they lower to a resumable C
	// function (a heap register frame + entry dispatch to the saved resume point)
	// rather than the straight-line shape below (see emitResumableFunction). (override
	// is only ever set for the boxed fallback of a promoting normal function, never a
	// coroutine.)
	if (fn.isGenerator || fn.isAsync) {
		return emitResumableFunction(fn, index, suffix, debug, linkage, semanticProtectors);
	}

	// A function with its own captured slots needs a per-activation MalEnv node
	// (function_index == this function) for LOAD/STORE_CAPTURED(owner == self) and
	// for the closures it creates to capture. The interpreter's
	// push_function_frame allocates it; the compiled function allocates the same
	// node at entry (below) and reassigns `env` to it, so the body's captured
	// access and CREATE_FUNCTION see this activation's slots.
	const capturesEnv = fn.capturedCount > 0;

	const promotableParams = override?.promotable ?? numericParamCandidates(fn);
	const reps = inferReps(fn, promotableParams);

	// MalValue-typed registers can hold heap pointers, so they are GC roots: back
	// them with a contiguous `__gc_slots` array published as a MalRootFrame, so a
	// collection at a call/back-edge safepoint inside this function can mark them.
	// (number/boolean-rep registers hold unboxed scalars — never heap pointers.)
	// The registers ARE the slots (via `#define r<i> (__gc_slots[<slot>])`), so no
	// spilling is needed; every exit must unlink the frame (gcUnlink).
	//
	// Only registers LIVE AT A SAFEPOINT need rooting (C1 liveness minimization):
	// `gcRootRegisters` (from the liveness pass, attached in lower-vm) is the set of
	// registers live at or used by a point where GC can run — every property access,
	// binary op, iterator step, call, and back-edge, since each can re-enter JS or
	// allocate. A boxed register absent from this set is dead at every collection
	// point, so it stays a plain C local the compiler can keep in a register rather
	// than an address-taken root slot. Rooting a safepoint's *operands* (not just
	// values live across it) preserves the invariant the runtime relies on: the
	// caller keeps an in-flight call's receiver/args reachable for the callee. When
	// the set is absent (generator/async, which this backend does not compile, or a
	// future op the liveness pass cannot see), fall back to rooting every boxed
	// register.
	const rootRegisters =
		fn.gcRootRegisters !== undefined ? new Set(fn.gcRootRegisters) : null;
	const valueRegs: Array<number> = [];
	for (let i = 0; i < fn.registerCount; i++) {
		const isBoxed = reps[i] !== "number" && reps[i] !== "boolean";
		if (isBoxed && (rootRegisters === null || rootRegisters.has(i))) {
			valueRegs.push(i);
		}
	}
	const slotOf = new Map<number, number>();
	valueRegs.forEach((reg, slot) => slotOf.set(reg, slot));
	const slotCount = valueRegs.length;

	// A derived constructor's `this` is uninitialized (the EMPTY sentinel) until
	// super() binds it, and CONSTRUCT_SUPER reassigns it mid-body — so it can't be
	// the immutable `this_value` parameter. It lives in its own rooted slot (the
	// bound instance is live across the rest of the body), initialized from the
	// EMPTY parameter and read through the TDZ-checked LOAD_THIS / RETURN forms.
	const thisSlot = fn.isDerivedConstructor ? slotCount : -1;
	const stackSlotsBase = slotCount + (fn.isDerivedConstructor ? 1 : 0);
	const stackObjectSites = new Map<number, StackObjectSite>();
	let nextStackSlot = stackSlotsBase;
	for (const site of fn.stackObjectSites ?? []) {
		const instruction = fn.instructions[site.instructionIndex];
		if (
			(instruction?.opcode !== "CREATE_OBJECT" &&
				instruction?.opcode !== "CREATE_OBJECT_SHAPED") ||
			(instruction.opcode === "CREATE_OBJECT"
				? site.slotCount !== 0
				: instruction.count !== site.slotCount) ||
			stackObjectSites.has(site.instructionIndex)
		) {
			throw new Error(
				`Invalid stack-object metadata at instruction ${site.instructionIndex}`,
			);
		}
		stackObjectSites.set(site.instructionIndex, {
			objectName: `__stack_object_${site.instructionIndex}`,
			slotsOffset: nextStackSlot,
			slotCount: site.slotCount,
		});
		nextStackSlot += site.slotCount;
	}
	const stackObjectMaterializations = new Map<number, StackObjectSite>();
	for (const materialization of fn.stackObjectMaterializations ?? []) {
		const returnInstruction = fn.instructions[materialization.returnInstructionIndex];
		const site = stackObjectSites.get(materialization.allocationInstructionIndex);
		if (
			returnInstruction?.opcode !== "RETURN" ||
			site === undefined ||
			stackObjectMaterializations.has(materialization.returnInstructionIndex)
		) {
			throw new Error(
				`Invalid stack-object materialization metadata at instruction ${materialization.returnInstructionIndex}`,
			);
		}
		stackObjectMaterializations.set(materialization.returnInstructionIndex, site);
	}
	const stackObjectAccesses = new Map<number, { site: StackObjectSite; slot: number }>();
	for (const access of fn.stackObjectAccesses ?? []) {
		const instruction = fn.instructions[access.instructionIndex];
		const site = stackObjectSites.get(access.allocationInstructionIndex);
		if (
			(instruction?.opcode !== "LOAD_PROPERTY_STATIC" &&
				instruction?.opcode !== "STORE_PROPERTY_STATIC") ||
			site === undefined ||
			access.slot < 0 ||
			access.slot >= site.slotCount ||
			stackObjectAccesses.has(access.instructionIndex)
		) {
			throw new Error(
				`Invalid stack-object access metadata at instruction ${access.instructionIndex}`,
			);
		}
		stackObjectAccesses.set(access.instructionIndex, { site, slot: access.slot });
	}
	const stackObjectInheritedAccesses = new Map<number, StackObjectSite>();
	for (const access of fn.stackObjectInheritedAccesses ?? []) {
		const instruction = fn.instructions[access.instructionIndex];
		const site = stackObjectSites.get(access.allocationInstructionIndex);
		if (
			instruction?.opcode !== "LOAD_PROPERTY_STATIC" ||
			site === undefined ||
			site.inheritedLoadInstructionIndex !== undefined ||
			stackObjectInheritedAccesses.has(access.instructionIndex)
		) {
			throw new Error(
				`Invalid inherited stack-object access metadata at instruction ${access.instructionIndex}`,
			);
		}
		site.inheritedLoadInstructionIndex = access.instructionIndex;
		site.inheritedIcIndex = instruction.icIndex;
		site.inheritedFastName = `${site.objectName}_inherited_fast`;
		site.inheritedValueName = `${site.objectName}_inherited_value`;
		site.inheritedGuard = access.guard;
		stackObjectInheritedAccesses.set(access.instructionIndex, site);
	}
	const finiteRecordRegions = new Map<number, FiniteRecordRegion>();
	const finiteRecordStores = new Map<number, FiniteRecordRegion>();
	const finiteRecordAccesses = new Map<number, FiniteRecordRegion>();
	for (let ip = 0; ip < fn.instructions.length; ip++) {
		const instruction = fn.instructions[ip]!;
		const finite =
			instruction.opcode === "CREATE_OBJECT"
				? instruction.nativeFiniteConstruction
				: undefined;
		if (finite?.virtualRecord !== true) continue;
		if (finite.keyStringIndices.length === 0 || finite.keyStringIndices.length > 8) {
			throw new Error(`Invalid virtual finite-record width at instruction ${ip}`);
		}
		const stores = fn.instructions
			.map((candidate, candidateIp) => ({ candidate, candidateIp }))
			.filter(
				(
					entry,
				): entry is {
					candidate: Extract<VmInstruction, { opcode: "STORE_PROPERTY" }>;
					candidateIp: number;
				} =>
					entry.candidate.opcode === "STORE_PROPERTY" &&
					entry.candidate.icIndex === finite.icIndex &&
					entry.candidate.nativeFiniteKey !== undefined,
			);
		if (stores.length !== 1) {
			throw new Error(`Invalid virtual finite-record store at instruction ${ip}`);
		}
		const region: FiniteRecordRegion = {
			allocationInstructionIndex: ip,
			slotsOffset: nextStackSlot,
			slotCount: finite.keyStringIndices.length,
			fastName: `__finite_record_${ip}_fast`,
		};
		nextStackSlot += region.slotCount;
		finiteRecordRegions.set(ip, region);
		finiteRecordStores.set(stores[0]!.candidateIp, region);
	}
	for (let ip = 0; ip < fn.instructions.length; ip++) {
		const instruction = fn.instructions[ip]!;
		if (
			instruction.opcode !== "LOAD_PROPERTY" ||
			instruction.nativeFiniteRecordAccess === undefined
		) {
			continue;
		}
		const region = finiteRecordRegions.get(
			instruction.nativeFiniteRecordAccess.allocationInstructionIndex,
		);
		if (region === undefined || instruction.nativeFiniteKey === undefined) {
			throw new Error(`Invalid virtual finite-record access at instruction ${ip}`);
		}
		finiteRecordAccesses.set(ip, region);
	}
	const cardinalityRegions = new Map<number, CardinalityRegion>();
	const cardinalityAccesses = new Map<
		number,
		{
			region: CardinalityRegion;
			role: "push" | "length" | "element" | "field";
			fieldSlot?: number;
		}
	>();
	const cardinalityPushes = new Map<number, CardinalityRegion>();
	const cardinalityHistorySlotLimit = stackSlotsBase + 512;
	for (let ip = 0; ip < fn.instructions.length; ip++) {
		const instruction = fn.instructions[ip]!;
		if (
			instruction.opcode !== "CREATE_ARRAY" ||
			instruction.nativeCardinalityRegion === undefined
		) {
			continue;
		}
		const pushes = fn.instructions
			.map((candidate, candidateIp) => ({ candidate, candidateIp }))
			.filter(
				(
					entry,
				): entry is {
					candidate: Extract<VmInstruction, { opcode: "CALL" }>;
					candidateIp: number;
				} =>
					entry.candidate.opcode === "CALL" &&
					entry.candidate.nativeCardinalityPush?.allocationInstructionIndex === ip,
			);
		if (pushes.length !== 1) continue;
		if (pushes[0]!.candidate.arguments.length !== 1) continue;
		const receiver = decodeVmValueOperand(pushes[0]!.candidate.thisValue);
		const pushedValue = decodeVmValueOperand(pushes[0]!.candidate.arguments[0]!);
		if (receiver.kind !== "register" || pushedValue.kind !== "register") continue;
		const pushedSite = stackObjectSites.get(
			pushes[0]!.candidate.nativeCardinalityPush!
				.pushedStackObjectAllocationInstructionIndex,
		);
		const pushedInstruction =
			fn.instructions[
				pushes[0]!.candidate.nativeCardinalityPush!
					.pushedStackObjectAllocationInstructionIndex
			];
		if (
			pushedSite === undefined ||
			pushedSite.slotCount === 0 ||
			pushedInstruction?.opcode !== "CREATE_OBJECT_SHAPED"
		) {
			continue;
		}
		const historySlotCount =
			instruction.nativeCardinalityRegion.maximumLength * pushedSite.slotCount;
		if (
			instruction.nativeCardinalityRegion.maximumLength <= 0 ||
			nextStackSlot + historySlotCount > cardinalityHistorySlotLimit
		) {
			continue;
		}
		const license = vmRegionLicense(
			[instruction.nativeCardinalityRegion.guard],
			"whole-region",
		);
		if (license === undefined) continue;
		const region: CardinalityRegion = {
			allocationInstructionIndex: ip,
			arrayRegister: receiver.register,
			maximumLength: instruction.nativeCardinalityRegion.maximumLength,
			license,
			semanticEpochStable: false,
			epochName: `__cardinality_${ip}_semantic_epoch`,
			itemSite: pushedSite,
			itemRegister: pushedValue.register,
			itemShapeCacheIndex: pushedInstruction.shapeCacheIndex,
			itemKeyStringIndices: [...pushedInstruction.keyStringIndices],
			historySlotsOffset: nextStackSlot,
			fastName: `__cardinality_${ip}_fast`,
			countName: `__cardinality_${ip}_count`,
			shapeName: `__cardinality_${ip}_shape`,
			currentMaterializedName: `__cardinality_${ip}_current_materialized`,
			elementIndexName: `__cardinality_${ip}_element_index`,
		};
		pushedSite.cardinalityRegion = region;
		nextStackSlot += historySlotCount;
		cardinalityRegions.set(ip, region);
		cardinalityPushes.set(pushes[0]!.candidateIp, region);
	}
	for (let ip = 0; ip < fn.instructions.length; ip++) {
		const instruction = fn.instructions[ip]!;
		if (
			(instruction.opcode !== "LOAD_PROPERTY" &&
				instruction.opcode !== "LOAD_PROPERTY_STATIC") ||
			instruction.nativeCardinalityAccess === undefined
		) {
			continue;
		}
		const region = cardinalityRegions.get(
			instruction.nativeCardinalityAccess.allocationInstructionIndex,
		);
		if (region !== undefined) {
			cardinalityAccesses.set(ip, {
				region,
				role: instruction.nativeCardinalityAccess.role,
				fieldSlot: instruction.nativeCardinalityAccess.fieldSlot,
			});
		}
	}
	for (const region of cardinalityRegions.values()) {
		const operationIps = new Set<number>([region.allocationInstructionIndex]);
		for (const [ip, access] of cardinalityAccesses) {
			if (access.region === region) operationIps.add(ip);
		}
		for (const [ip, pushRegion] of cardinalityPushes) {
			if (pushRegion === region) operationIps.add(ip);
		}
		const lastIp = Math.max(...operationIps);
		let stable = true;
		for (let ip = region.allocationInstructionIndex + 1; ip <= lastIp; ip++) {
			if (operationIps.has(ip)) continue;
			if (nativeInstructionMayInvalidateSemanticEpoch(fn.instructions[ip]!, reps)) {
				stable = false;
				break;
			}
		}
		if (stable) {
			const externalEntryIps = new Set<number>();
			for (let sourceIp = 0; sourceIp < fn.instructions.length; sourceIp++) {
				const instruction = fn.instructions[sourceIp]!;
				if (instruction.opcode === "JUMP" || instruction.opcode === "JUMP_IF") {
					if (sourceIp < region.allocationInstructionIndex || sourceIp > lastIp) {
						externalEntryIps.add(instruction.targetIp);
					}
				}
			}
			// Exception handlers are implicit CFG entries rather than JUMP opcodes.
			for (const handler of fn.handlers) externalEntryIps.add(handler.handlerIp);
			stable = ![...externalEntryIps].some(
				(targetIp) => targetIp > region.allocationInstructionIndex && targetIp <= lastIp,
			);
		}
		region.semanticEpochStable = stable;
	}
	const stringSplitProjectionSites = new Map<number, NativeStringSplitProjectionSite>();
	for (const projection of fn.nativeStringSplitProjections ?? []) {
		const call = fn.instructions[projection.callIp];
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
			continue;
		}
		stringSplitProjectionSites.set(projection.callIp, {
			projection,
			slotsOffset: nextStackSlot,
			elementLoads,
			lockedIdentity:
				call?.opcode === "CALL_BUILTIN" ||
				(call?.opcode === "CALL" && vmGuardIsWorldInvariant(projection.license.guard)),
		});
		nextStackSlot += elementLoads.length;
	}
	const stringSplitCursorSites = new Map<number, NativeStringSplitCursorSite>();
	const stringSplitCursorRegions = (fn.regions ?? []).filter(
		(region): region is NativeStringSplitCursor => region.kind === "string-split-cursor",
	);
	for (const cursor of stringSplitCursorRegions) {
		const callIp = cursor.anchors[0]!;
		const lengthIp = cursor.anchors[1]!;
		const backedgeIp = cursor.anchors[2]!;
		if (stringSplitCursorSites.has(callIp)) continue;
		const call = fn.instructions[callIp];
		const trimCall = fn.instructions[cursor.trimCallIp];
		const lockedLicense = vmGuardIsWorldInvariant(cursor.license.guard);
		const cursorOperations = new Set([
			lengthIp,
			cursor.elementIp,
			cursor.trimPropertyIp,
			cursor.trimCallIp,
			...cursor.primitiveStringLengthIps,
		]);
		let semanticEpochStable = true;
		for (let ip = callIp + 1; ip <= backedgeIp; ip++) {
			if (cursorOperations.has(ip)) continue;
			if (nativeInstructionMayInvalidateSemanticEpoch(fn.instructions[ip]!, reps)) {
				semanticEpochStable = false;
				break;
			}
		}
		const hoistTrimIdentity = !lockedLicense;
		stringSplitCursorSites.set(callIp, {
			cursor,
			callIp,
			lengthIp,
			backedgeIp,
			subjectSlot: nextStackSlot,
			separatorSlot: nextStackSlot + 1,
			...(hoistTrimIdentity ? { trimCalleeSlot: nextStackSlot + 2 } : {}),
			semanticEpochStable,
			epochName: `__string_split_cursor_${callIp}_semantic_epoch`,
			lockedIdentity:
				call?.opcode === "CALL_BUILTIN" ||
				(call?.opcode === "CALL" &&
					call.guardedBuiltinCall !== undefined &&
					vmGuardIsWorldInvariant(call.guardedBuiltinCall.guard)),
			lockedTrimIdentity:
				trimCall?.opcode === "CALL" &&
				trimCall.guardedBuiltinCall !== undefined &&
				vmGuardIsWorldInvariant(trimCall.guardedBuiltinCall.guard),
		});
		nextStackSlot += hoistTrimIdentity ? 3 : 2;
	}
	const regexpExecProjectionSites = new Map<number, NativeRegExpExecProjectionSite>();
	for (const projection of fn.nativeRegExpExecProjections ?? []) {
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
			continue;
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
	for (const projection of fn.nativeRegExpIteratorProjections ?? []) {
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
			continue;
		}
		regexpIteratorProjectionSites.set(projection.stepIp, {
			projection,
			subjectSlot: nextStackSlot,
			slotsOffset: nextStackSlot + 1,
			loads,
		});
		nextStackSlot += loads.length + 1;
	}
	const invariantJsonParseCaches = new Map<
		number,
		NonNullable<VmFunction["nativeInvariantJsonParseCaches"]>[number] & {
			rootsOffset: number;
		}
	>();
	const invariantJsonMapTemplates = new Map<
		number,
		NonNullable<VmFunction["nativeInvariantJsonMapTemplates"]>[number] & {
			rootsOffset: number;
		}
	>();
	for (const template of fn.nativeInvariantJsonMapTemplates ?? []) {
		const parse = fn.instructions[template.parseCallIp];
		const load = fn.instructions[template.mapLoadIp];
		const call = fn.instructions[template.mapCallIp];
		if (
			parse?.opcode !== "CALL" ||
			parse.dst !== template.parseResult ||
			parse.callee !== template.parseCallee ||
			parse.thisValue !== template.jsonObject ||
			load?.opcode !== "LOAD_PROPERTY_STATIC" ||
			load.object !== template.parseResult ||
			load.dst !== template.mapCallee ||
			call?.opcode !== "CALL" ||
			call.callee !== template.mapCallee ||
			call.thisValue !== template.parseResult ||
			call.dst !== template.mapResult ||
			template.mapLoadIp !== template.parseCallIp + 1 ||
			template.mapCallIp !== template.parseCallIp + 2 ||
			template.captures.length === 0 ||
			template.captures.length > 8 ||
			invariantJsonMapTemplates.has(template.parseCallIp)
		) {
			throw new Error(
				`Invalid invariant JSON map template at instruction ${template.parseCallIp}`,
			);
		}
		invariantJsonMapTemplates.set(template.parseCallIp, {
			...template,
			rootsOffset: nextStackSlot,
		});
		nextStackSlot += 4 + template.captures.length;
	}
	for (const cache of fn.nativeInvariantJsonParseCaches ?? []) {
		if (invariantJsonMapTemplates.has(cache.callIp)) continue;
		const instruction = fn.instructions[cache.callIp];
		if (
			instruction?.opcode !== "CALL" ||
			instruction.dst !== cache.result ||
			invariantJsonParseCaches.has(cache.callIp)
		) {
			throw new Error(
				`Invalid invariant JSON parse cache at instruction ${cache.callIp}`,
			);
		}
		invariantJsonParseCaches.set(cache.callIp, {
			...cache,
			rootsOffset: nextStackSlot,
		});
		nextStackSlot += 2;
	}
	const privateAggregateMemos = new Map<
		number,
		NonNullable<VmFunction["nativePrivateAggregateMemos"]>[number] & {
			rootsOffset: number;
		}
	>();
	for (const memo of fn.nativePrivateAggregateMemos ?? []) {
		const instruction = fn.instructions[memo.callIp];
		const allocation = fn.instructions[memo.allocationIp];
		const callee =
			instruction?.opcode === "CALL"
				? decodeVmValueOperand(instruction.callee)
				: undefined;
		const input =
			instruction?.opcode === "CALL" && instruction.arguments.length === 1
				? decodeVmValueOperand(instruction.arguments[0]!)
				: undefined;
		if (
			instruction?.opcode !== "CALL" ||
			instruction.dst !== memo.result ||
			callee?.kind !== "register" ||
			callee.register !== memo.callee ||
			instruction.arguments.length !== 1 ||
			input?.kind !== "register" ||
			input.register !== memo.input ||
			instruction.directFunctionIndex !== memo.targetFunctionIndex ||
			allocation?.opcode !== "CREATE_ARRAY" ||
			privateAggregateMemos.has(memo.callIp)
		) {
			throw new Error(`Invalid private aggregate memo at instruction ${memo.callIp}`);
		}
		privateAggregateMemos.set(memo.callIp, {
			...memo,
			rootsOffset: nextStackSlot,
		});
		nextStackSlot += 2;
	}
	const numericHofRegions = new Map<number, NumericHofRegionSite>();
	for (const region of fn.nativeNumericHofRegions ?? []) {
		const initialMove = fn.instructions[region.initialMoveIp];
		const entry = fn.instructions[region.entryIp];
		if (
			initialMove?.opcode !== "MOVE" ||
			initialMove.dst !== region.accumulator ||
			(region.dispatch.kind === "guarded"
				? entry?.opcode !== "CALL"
				: region.entryIp !== region.initialMoveIp || entry?.opcode !== "MOVE") ||
			numericHofRegions.has(region.entryIp)
		) {
			throw new Error(`Invalid numeric HOF region at instruction ${region.entryIp}`);
		}
		numericHofRegions.set(region.entryIp, region);
	}
	const affineRangeAllocations = fn.instructions
		.map((instruction, ip) => ({ instruction, ip }))
		.filter(
			(
				entry,
			): entry is {
				instruction: Extract<VmInstruction, { opcode: "CREATE_ARRAY" }>;
				ip: number;
			} =>
				entry.instruction.opcode === "CREATE_ARRAY" &&
				entry.instruction.nativeAffineRangeVirtualization?.role === "allocation" &&
				entry.instruction.nativeAffineRangeVirtualization.allocationIp === entry.ip,
		);
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
		finiteRecordRegions,
		finiteRecordStores,
		finiteRecordAccesses,
		cardinalityRegions,
		cardinalityAccesses,
		cardinalityPushes,
		stringSplitProjectionSites,
		stringSplitCursorSites,
		regexpExecProjectionSites,
		regexpIteratorProjectionSites,
		invariantJsonParseCaches,
		invariantJsonMapTemplates,
		privateAggregateMemos,
		numericHofRegions,
		directCompiledTargets,
		vmSemanticProtectorGuard(semanticProtectors, "watched-methods"),
		profileDecisions,
	);
	if (body === null) {
		return null;
	}
	const nativeNumberCallTargets = new Set<number>();
	for (const target of directCompiledTargets.keys()) {
		if (
			body.some((line) =>
				line.includes(`mal_compiled_${target}${suffix}_native_numbers(`),
			)
		) {
			nativeNumberCallTargets.add(target);
		}
	}

	// Defensive: a register operand of -1 (a "no register" sentinel beyond the
	// RETURN case handled below) would emit invalid C like `r-1`. Bail to the
	// interpreter rather than emit broken code.
	if (body.some((line) => /\br-\d/.test(line))) {
		return null;
	}

	// Parameters that qualified for promotion AND survived inferReps as
	// number-rep (i.e. were not reassigned to a non-number) are unboxed once at
	// entry behind a speculative guard.
	const promotedParams = Array.from({ length: fn.parameterCount }, (_, i) => i).filter(
		(i) => promotableParams.has(i) && reps[i] === "number",
	);
	const isPromoted = new Set(promotedParams);
	const observesRawArguments = fn.instructions.some(
		(instruction) =>
			instruction.opcode === "LOAD_ARGUMENT_COUNT" ||
			instruction.opcode === "LOAD_ARGUMENT" ||
			instruction.opcode === "LOAD_STATIC_ARGUMENT" ||
			instruction.opcode === "CREATE_REST_ARGUMENTS",
	);
	const nativeNumberArgumentCount =
		fn.parameterCount > 0 &&
		fn.parameterCount <= 4 &&
		// A wrapper/secondary entry can perturb the layout of a large hot body more
		// than one saved box/unbox is worth. Keep this ABI seam for compact callees;
		// larger proof regions need a native result ABI or call-region versioning.
		body.length <= 256 &&
		promotedParams.length === fn.parameterCount &&
		!fn.needsArguments &&
		!fn.mappedArguments &&
		fn.argumentSnapshotCount === 0 &&
		!observesRawArguments
			? fn.parameterCount
			: 0;

	const symbol = override?.symbol ?? `mal_compiled_${index}${suffix}`;
	const useNativeNumberEntry =
		override === undefined &&
		nativeNumberArgumentCount > 0 &&
		directCompiledTargets.get(index) === nativeNumberArgumentCount;
	const implementationSymbol = useNativeNumberEntry ? `${symbol}_native_numbers` : symbol;

	// PARAM-BAIL FALLBACK: when this variant speculatively unboxes params, its
	// entry guard must have somewhere to go when an argument is not a number.
	// Rather than re-enter the bytecode interpreter (which would keep the whole
	// interpreter live), emit a second, fully-boxed variant of this same function
	// and jump there. That variant promotes nothing, so it never bails — no
	// compiled function depends on the interpreter, and the bytecode overlay can
	// be dropped for every compiled function.
	let fallbackSource = "";
	let bailTarget = "";
	const fallbackNativeNumberCallTargets = new Set<number>();
	if (promotedParams.length > 0) {
		const boxedSymbol = `mal_compiled_${index}_boxed${suffix}`;
		const boxed = emitCompiledFunction(
			fn,
			index,
			suffix,
			debug,
			{ symbol: boxedSymbol, promotable: new Set() },
			linkage,
			directCompiledTargets,
			semanticProtectors,
		);
		if (boxed === null) {
			return null; // the promoting variant lowered, so this cannot happen
		}
		fallbackSource = `${boxed.source}\n\n`;
		bailTarget = `${boxedSymbol}(vm, this_value, args, arg_count, new_target, env, callee, entry_state)`;
		for (const target of boxed.nativeNumberCallTargets) {
			fallbackNativeNumberCallTargets.add(target);
		}
	}

	const lines: Array<string> = [];

	lines.push(
		`${useNativeNumberEntry ? "static __attribute__((aligned(64))) " : linkage === "static" ? "static " : ""}MalValue ${implementationSymbol}(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalEnv *env, MalValue callee, void *entry_state${useNativeNumberEntry ? ", f64 native_arg0, f64 native_arg1, f64 native_arg2, f64 native_arg3" : ""}) {`,
	);
	lines.push(`    (void) this_value;`);
	lines.push(`    (void) new_target;`);
	lines.push(`    (void) env;`);
	lines.push(`    (void) callee;`);
	if (!useNativeNumberEntry) lines.push(`    (void) entry_state;`);
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
		if (site.inheritedLoadInstructionIndex !== undefined) {
			lines.push(`    bool ${site.inheritedFastName} = false;`);
			lines.push(`    MalValue ${site.inheritedValueName} = MAL_VALUE_UNDEFINED;`);
		}
	}
	for (const region of finiteRecordRegions.values()) {
		lines.push(`    bool ${region.fastName} = false;`);
	}
	for (const region of cardinalityRegions.values()) {
		lines.push(`    bool ${region.fastName} = false;`);
		if (!region.semanticEpochStable) {
			lines.push(`    u64 ${region.epochName} = 0;`);
		}
		lines.push(`    u32 ${region.countName} = 0;`);
		lines.push(`    MalShape *${region.shapeName} = nullptr;`);
		lines.push(`    bool ${region.currentMaterializedName} = false;`);
		lines.push(`    i32 ${region.elementIndexName} = -1;`);
	}
	for (const cache of invariantJsonParseCaches.values()) {
		lines.push(
			`    MalInvariantJsonParseCache __invariant_json_parse_${cache.callIp} = { .roots = &__gc_slots[${cache.rootsOffset}], .filled = false };`,
		);
	}
	for (const template of invariantJsonMapTemplates.values()) {
		lines.push(
			`    MalInvariantJsonMapTemplate __invariant_json_map_${template.parseCallIp} = { .roots = &__gc_slots[${template.rootsOffset}], .state = MAL_INVARIANT_JSON_MAP_EMPTY };`,
			`    bool __invariant_json_map_${template.parseCallIp}_hit = false;`,
		);
	}
	for (const memo of privateAggregateMemos.values()) {
		lines.push(
			`    MalPrivateAggregateMemo __private_aggregate_memo_${memo.callIp} = { .roots = &__gc_slots[${memo.rootsOffset}], .state = MAL_PRIVATE_AGGREGATE_MEMO_EMPTY, .private_ok = false, .admitted = false };`,
		);
	}
	for (const allocation of affineRangeAllocations) {
		lines.push(`    bool __affine_range_${allocation.ip} = false;`);
	}
	for (let i = 0; i < fn.registerCount; i++) {
		const slot = slotOf.get(i);
		if (slot !== undefined) {
			lines.push(`#define r${i} (__gc_slots[${slot}])`);
		} else {
			lines.push(`    ${cTypeOf(reps[i]!)} r${i};`);
		}
	}

	// Promoted parameters: load each boxed, guard that every one is a number, and
	// fall back to the fully-boxed variant when any is not. undefined (incl. a
	// missing argument) is not a number, so under-application takes the boxed path
	// and behaves identically. Past the guard the fast body runs fully unboxed with
	// no per-op number checks.
	if (promotedParams.length > 0) {
		if (useNativeNumberEntry) {
			lines.push(`    if (entry_state != nullptr) {`);
			for (const i of promotedParams) {
				lines.push(`        r${i} = native_arg${i};`);
			}
			lines.push(`    } else {`);
		}
		for (const i of promotedParams) {
			lines.push(
				`${useNativeNumberEntry ? "    " : ""}    MalValue p${i} = arg_count > ${i} ? args[${i}] : MAL_VALUE_UNDEFINED;`,
			);
		}
		const guard = promotedParams.map((i) => `!mal_ops_is_number(p${i})`).join(" || ");
		lines.push(
			`${useNativeNumberEntry ? "    " : ""}    if (${guard}) {`,
			`${useNativeNumberEntry ? "    " : ""}        return ${bailTarget};`,
			`${useNativeNumberEntry ? "    " : ""}    }`,
		);
		for (const i of promotedParams) {
			lines.push(
				`${useNativeNumberEntry ? "    " : ""}    r${i} = mal_ops_number_as_f64(p${i});`,
			);
		}
		if (useNativeNumberEntry) lines.push(`    }`);
	}

	// Remaining parameters adopt the incoming arguments boxed; non-parameter
	// registers start at a rep-appropriate zero.
	for (let i = 0; i < fn.parameterCount; i++) {
		if (isPromoted.has(i)) {
			continue;
		}
		lines.push(`    r${i} = arg_count > ${i} ? args[${i}] : MAL_VALUE_UNDEFINED;`);
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
	// The promoted-param guard above returns before this point (no unlink).
	if (needsRootFrame) {
		lines.push(
			`    static const MalFrameDescriptor __gc_desc = { .function_index = ${index}, .slot_count = ${totalSlots} };`,
			`    MalRootFrame __gc_frame = { .prev = mal_root_frame_head, .desc = &__gc_desc, .slots = ${totalSlots > 0 ? "__gc_slots" : "nullptr"}, .env = nullptr };`,
			`    mal_root_frame_head = &__gc_frame;`,
		);
	}

	// Allocate this activation's captured-slot env (mirroring the interpreter) and
	// reassign `env` so the body's LOAD/STORE_CAPTURED(self) and CREATE_FUNCTION use
	// it, then root it in the published frame. capturesEnv implies needsRootFrame.
	if (capturesEnv) {
		lines.push(
			`    env = mal_env_new(vm, env, ${index}, ${fn.capturedCount});`,
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
		thisSlot >= 0
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
		lines.push(`__throw_exit:;`, `    ${gcUnlink}return MAL_VALUE_UNDEFINED;`);
	}
	lines.push("}");
	for (const i of valueRegs) {
		lines.push(`#undef r${i}`);
	}
	if (useNativeNumberEntry) {
		lines.push(
			"",
			`${linkage === "static" ? "static " : ""}MalValue ${symbol}(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalEnv *env, MalValue callee, void *entry_state) {`,
			`    return ${implementationSymbol}(vm, this_value, args, arg_count, new_target, env, callee, entry_state, 0.0, 0.0, 0.0, 0.0);`,
			`}`,
		);
	}

	return {
		symbol,
		source: fallbackSource + lines.join("\n"),
		nativeNumberArgumentCount,
		nativeNumberCallTargets: new Set([
			...fallbackNativeNumberCallTargets,
			...nativeNumberCallTargets,
		]),
		profileDecisions,
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
	fn: VmFunction,
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
	const body = emitBody(
		fn,
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
		new Map(),
		new Map(),
		new Map(),
		new Map(),
		new Map(),
		new Map(),
		new Map(),
		new Map(),
		new Map(),
		new Map(),
		new Map(),
		vmSemanticProtectorGuard(semanticProtectors, "watched-methods"),
		profileDecisions,
	);
	if (body === null) {
		return null;
	}
	if (body.some((line) => /\br-\d/.test(line))) {
		return null;
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
		`        __gc_frame = (MalRootFrame){ .prev = mal_root_frame_head, .desc = &__gc_desc, .slots = __gc_slots, .env = env };`,
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
		`        __gc_frame = (MalRootFrame){ .prev = mal_root_frame_head, .desc = &__gc_desc, .slots = __gc_slots, .env = env };`,
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
		nativeNumberArgumentCount: 0,
		nativeNumberCallTargets: new Set(),
		profileDecisions,
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
	return rep === "number" ? "double" : rep === "boolean" ? "bool" : "MalValue";
}

/** The zero/default value a register of the given rep is initialized to. */
function zeroOf(rep: RegisterRep): string {
	return rep === "number" ? "0.0" : rep === "boolean" ? "false" : "MAL_VALUE_UNDEFINED";
}

/**
 * Join two reps for a register written by more than one instruction: a register
 * that only ever holds one native kind keeps it; any disagreement (or a boxed
 * definition) makes it `boxed`. `null` is the optimistic top (no info yet).
 */
function joinReps(current: RegisterRep | null, produced: RegisterRep): RegisterRep {
	if (current === null) {
		return produced;
	}
	return current === produced ? current : "boxed";
}

/**
 * Forward fixpoint over the rep lattice (top = unknown, then {number, boolean},
 * bottom = boxed). A register's rep is the join of the reps its definitions
 * produce; producedRep depends on operand reps, so iterate to a fixpoint. Reps
 * only move down (unknown → native → boxed), so it converges.
 *
 * Parameters hold incoming (boxed) arguments, so by default they start — and
 * stay — boxed. A parameter in `promotableParams` is instead *speculatively*
 * seeded as `number`: if it has no other definition it stays number-rep (and is
 * unboxed at entry behind a guard); if the body reassigns it to a non-number,
 * that definition joins it back to boxed and it is not promoted.
 */
function inferReps(fn: VmFunction, promotableParams: Set<number>): Array<RegisterRep> {
	const reps: Array<RegisterRep | null> = Array.from(
		{ length: fn.registerCount },
		() => null,
	);
	for (let i = 0; i < fn.parameterCount; i++) {
		reps[i] = promotableParams.has(i) ? "number" : "boxed";
	}

	let changed = true;
	while (changed) {
		changed = false;
		for (const instruction of fn.instructions) {
			const produced = producedRep(instruction, reps);
			// A definition whose rep can't be determined yet (an operand is still
			// unknown) is left for a later iteration rather than forced to boxed.
			if (produced === null) {
				continue;
			}
			for (const dst of writeRegisters(instruction)) {
				if (dst < 0) {
					continue;
				}
				const joined = joinReps(reps[dst] ?? null, produced);
				if (joined !== reps[dst]) {
					reps[dst] = joined;
					changed = true;
				}
			}
		}
	}

	// A register never written (so never read in well-formed IR) resolves to a
	// boxed undefined.
	return reps.map((rep) => rep ?? "boxed");
}

/**
 * Every register an instruction writes. Most ops write a single `dst`; the
 * iterator ops write two (the GET_ITERATOR iterator/next pair, the ITERATOR_STEP
 * value/done pair), both boxed. Reporting all of them keeps inferReps from
 * mis-typing a register that the allocator also reused for a numeric value.
 */
function writeRegisters(instruction: VmInstruction): Array<number> {
	switch (instruction.opcode) {
		case "GET_ITERATOR":
		case "GET_ASYNC_ITERATOR":
			return [instruction.iteratorDst, instruction.nextDst];
		case "ITERATOR_STEP":
			return [instruction.valueDst, instruction.doneDst];
		default: {
			const dst = (instruction as { dst?: number }).dst;
			return typeof dst === "number" ? [dst] : [];
		}
	}
}

/** Whether this instruction can synchronously capture the current JS stack,
 * directly or by re-entering user code. The whitelist is intentionally narrow;
 * unknown/helper operations publish the pending source position. */
function nativeInstructionMayCaptureStack(
	instruction: VmInstruction,
	reps: Array<RegisterRep>,
): boolean {
	switch (instruction.opcode) {
		case "MOVE":
		case "CREATE_UNDEFINED":
		case "CREATE_NULL":
		case "CREATE_EMPTY":
		case "CREATE_BOOLEAN":
		case "CREATE_NUMBER":
		case "CREATE_F64":
		case "CREATE_STRING":
		case "CREATE_BIGINT":
		case "LOAD_ARGUMENT_COUNT":
		case "LOAD_ARGUMENT":
		case "LOAD_NEW_TARGET":
		case "LOAD_CALLEE":
		case "GUARD_FUNCTION_INDEX":
		case "LOAD_CAPTURED":
		case "STORE_CAPTURED":
		case "LOAD_GLOBAL":
		case "STORE_GLOBAL":
		case "LOAD_INTRINSIC":
		case "IS_EMPTY":
		case "TYPEOF_COMPARE":
		case "MATH_UNARY_NUMBER":
		case "MATH_BINARY_NUMBER":
		case "JUMP":
		case "JUMP_IF":
		case "CATCH":
			return false;
		case "BINARY":
			return !(
				(reps[instruction.left] === "number" && reps[instruction.right] === "number") ||
				instruction.operator === "===" ||
				instruction.operator === "!=="
			);
		case "UNARY":
			return !(reps[instruction.src] === "number" || instruction.operator === "!");
		default:
			return true;
	}
}

/**
 * Whether an instruction outside a cardinality region's own fast operations may
 * synchronously run JavaScript and therefore mutate a watched semantic family.
 * Allocation and GC are safe: this runtime's collector does not run finalizers or
 * jobs inside a safepoint. Unknown instructions fail closed.
 */
function nativeInstructionMayInvalidateSemanticEpoch(
	instruction: VmInstruction,
	reps: Array<RegisterRep>,
): boolean {
	switch (instruction.opcode) {
		case "CREATE_OBJECT":
		case "CREATE_OBJECT_SHAPED":
		case "CREATE_ARRAY":
		case "MATH_UNARY_NUMBER":
		case "MATH_BINARY_NUMBER":
			return false;
		case "LOAD_PROPERTY":
		case "STORE_PROPERTY":
			if (instruction.nativeClosedGlobalTable?.direct === true) return false;
			return true;
		case "LOAD_PROPERTY_STATIC":
			return instruction.nativePrimitiveStringLength !== true;
		case "BINARY":
			if (
				instruction.operator === "+" &&
				instruction.nativeFiniteString !== undefined &&
				reps[instruction.right] === "number"
			) {
				return false;
			}
			return nativeInstructionMayCaptureStack(instruction, reps);
		default:
			return nativeInstructionMayCaptureStack(instruction, reps);
	}
}

/**
 * The rep an instruction's result naturally has, given current operand reps, or
 * null when an operand is still unknown (defer to a later fixpoint iteration).
 * Comparisons and `!` always yield a boolean; native arithmetic over numbers
 * yields a number; everything else is boxed.
 */
function producedRep(
	instruction: VmInstruction,
	reps: Array<RegisterRep | null>,
): RegisterRep | null {
	switch (instruction.opcode) {
		case "CREATE_NUMBER":
		case "CREATE_F64":
		case "MATH_UNARY_NUMBER":
		case "MATH_BINARY_NUMBER":
			return "number";
		case "CREATE_BOOLEAN":
			return "boolean";
		case "GUARD_FUNCTION_INDEX":
		case "TYPEOF_COMPARE":
			return "boolean";
		case "MOVE":
			return reps[instruction.src] ?? null;
		case "BINARY": {
			if (instruction.operator in NATIVE_COMPARE) {
				return "boolean";
			}
			if (producesNumberFromNumbers(instruction.operator)) {
				const left = reps[instruction.left] ?? null;
				const right = reps[instruction.right] ?? null;
				if (left === null || right === null) {
					return null;
				}
				return left === "number" && right === "number" ? "number" : "boxed";
			}
			return "boxed";
		}
		case "UNARY": {
			if (instruction.operator === "!") {
				return "boolean";
			}
			if (
				instruction.operator === "-" ||
				instruction.operator === "+" ||
				instruction.operator === "~" ||
				instruction.operator === "tonumeric" ||
				instruction.operator === "increment" ||
				instruction.operator === "decrement"
			) {
				const src = reps[instruction.src] ?? null;
				return src === null ? null : src === "number" ? "number" : "boxed";
			}
			return "boxed";
		}
		case "CALL": {
			const guarded = instruction.guardedBuiltinCall;
			const descriptor =
				guarded === undefined ? undefined : builtinOperationDescriptor(guarded.operation);
			if (
				guarded === undefined ||
				!vmGuardIsWorldInvariant(guarded.guard) ||
				descriptor?.nativeNumberArity !== instruction.arguments.length
			) {
				return "boxed";
			}
			for (const operand of instruction.arguments) {
				const decoded = decodeVmValueOperand(operand);
				if (decoded.kind === "register" && reps[decoded.register] === null) {
					return null;
				}
				if (decoded.kind !== "number" && decoded.kind !== "register") {
					return "boxed";
				}
				if (decoded.kind === "register" && reps[decoded.register] !== "number") {
					return "boxed";
				}
			}
			return "number";
		}
		default:
			return "boxed";
	}
}

/**
 * A property-access instruction's membership in a guarded region (see the region
 * detection in emitBody). `name` is the region's base identifier; `declare` marks the
 * run's first access (which emits the hoisted receiver guard). For a consolidated object
 * region (`consolidated`, ≥2 string-key accesses on one object), `slotIndex` is this
 * access's position in the region's cached-slot array; `commit` marks the run's
 * last access, where the slow path can commit the aggregate region cache.
 */
interface RegionAccess {
	name: string;
	kind: "array" | "object";
	declare: boolean;
	consolidated: boolean;
	revalidate: boolean;
	slotIndex: number;
	size: number;
	leadingIcIndex: number;
	icIndices: Array<number>;
	commit: boolean;
	/** Exact own data slot licensed by a closed record-Array region. */
	closedSlot?: number;
}

/**
 * One adjacent static Get + direct String#charCodeAt call. No instruction can
 * observe or invalidate state between the two operations, so native emission may
 * keep the complete pair behind one watched-method license while retaining the
 * original Get+Call in a cold fallback.
 */
interface StringCharCodeAtFusion {
	loadIp: number;
	callIp: number;
	load: Extract<VmInstruction, { opcode: "LOAD_PROPERTY_STATIC" }>;
	call: Extract<VmInstruction, { opcode: "CALL" }>;
}

type NativeStringScanRegion = NonNullable<VmFunction["nativeStringScanRegions"]>[number];

interface NativeStringScanRegionAction {
	region: NativeStringScanRegion;
	role: "entry" | "length";
}

type NativeStringSplitProjection = NonNullable<
	VmFunction["nativeStringSplitProjections"]
>[number];

interface NativeStringSplitProjectionSite {
	projection: NativeStringSplitProjection;
	slotsOffset: number;
	lockedIdentity: boolean;
	elementLoads: Array<
		NativeStringSplitProjection["loads"][number] & { kind: "element"; index: number }
	>;
}

interface NativeStringSplitProjectionAction {
	site: NativeStringSplitProjectionSite;
	role: "property" | "call" | "element" | "length";
	load?: NativeStringSplitProjection["loads"][number];
	propertyLoad?: Extract<VmInstruction, { opcode: "LOAD_PROPERTY_STATIC" }>;
}

type NativeStringSplitCursor = Extract<
	NonNullable<VmFunction["regions"]>[number],
	{ kind: "string-split-cursor" }
>;

interface NativeStringSplitCursorSite {
	cursor: NativeStringSplitCursor;
	callIp: number;
	lengthIp: number;
	backedgeIp: number;
	subjectSlot: number;
	separatorSlot: number;
	trimCalleeSlot?: number;
	semanticEpochStable: boolean;
	epochName: string;
	lockedIdentity: boolean;
	lockedTrimIdentity: boolean;
}

interface NativeStringSplitCursorAction {
	site: NativeStringSplitCursorSite;
	role: "property" | "call" | "length" | "element" | "trimProperty" | "trimCall";
	propertyLoad?: Extract<VmInstruction, { opcode: "LOAD_PROPERTY_STATIC" }>;
}

type NativeRegExpExecProjection = NonNullable<
	VmFunction["nativeRegExpExecProjections"]
>[number];

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
	propertyLoad?: Extract<VmInstruction, { opcode: "LOAD_PROPERTY_STATIC" }>;
}

type NativeRegExpIteratorProjection = NonNullable<
	VmFunction["nativeRegExpIteratorProjections"]
>[number];

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

type NativeStringSliceNumberFusion = NonNullable<
	VmFunction["nativeStringSliceNumberFusions"]
>[number];

interface NativeStringSliceNumberFusionAction {
	fusion: NativeStringSliceNumberFusion;
	role: "property" | "slice" | "number";
	lockedIdentity: boolean;
	propertyLoad?: Extract<VmInstruction, { opcode: "LOAD_PROPERTY_STATIC" }>;
}

/**
 * One exact natural loop that may execute a dependency-backed inherited static
 * load through a cloned native fast body. The ordinary body remains in place as
 * the generic twin. Entry and post-safepoint validation prove the IC row before
 * the fast body reads its cached value directly.
 */
interface InheritedLoadLoopTwin {
	headerIp: number;
	backedgeIp: number;
	propertyIp: number;
	receiver: number;
	icIndex: number;
	probeName: string;
	position: number;
	deferredRegisters: Array<number>;
	deferredMoveIps: ReadonlySet<number>;
	loadedName: string;
	summary?: InheritedLoadLoopSummary;
}

/**
 * Exact terminal state for the deliberately tiny counted-loop summary domain.
 * The runtime guard accepts only positive integral finite bounds through 2^53;
 * every other Number value executes the ordinary fast/generic loop twin.
 */
interface InheritedLoadLoopSummary {
	index: number;
	bound: number;
	condition: number;
	exitIp: number;
}

interface LoopTwinEmission {
	twin: InheritedLoadLoopTwin;
	kind: "fast" | "generic";
	publishPosition: boolean;
}

const LOOP_TWIN_SCALAR_OPCODES = new Set<VmInstruction["opcode"]>([
	"MOVE",
	"CREATE_UNDEFINED",
	"CREATE_NULL",
	"CREATE_EMPTY",
	"CREATE_BOOLEAN",
	"CREATE_NUMBER",
	"CREATE_F64",
	"IS_EMPTY",
	"TYPEOF_COMPARE",
	"BINARY",
	"UNARY",
	"JUMP",
	"JUMP_IF",
]);

function loopTwinValidation(twin: InheritedLoadLoopTwin): string {
	const receiver = `r${twin.receiver}`;
	const ic = `&__property_ic[${twin.icIndex}]`;
	return `(mal_vm_local_inherited_value_try_load_static(mal_vm_as_object(${receiver}), ${ic}, &${twin.probeName}) || mal_vm_local_watched_inherited_value_try_load_static(vm, __watched_methods_epoch, ${receiver}, ${ic}, &${twin.probeName}))`;
}

function loopTwinReadRegisters(instruction: VmInstruction): Array<number> {
	switch (instruction.opcode) {
		case "MOVE":
			return [instruction.src];
		case "IS_EMPTY":
		case "UNARY":
		case "TYPEOF_COMPARE":
			return [instruction.src];
		case "BINARY":
			return [instruction.left, instruction.right];
		case "JUMP_IF":
			return [instruction.cond];
		default:
			return [];
	}
}

/**
 * A dependency-backed value may stay in its IC owner throughout a fast loop
 * when it only flows through MOVEs. Materializing every member of the move chain
 * on exit preserves the VM-register state while removing repeated rooted-slot
 * stores from the hot body. Any real use or overwrite rejects deferral.
 */
function deferredInheritedMoveChain(
	fn: VmFunction,
	reps: Array<RegisterRep>,
	headerIp: number,
	backedgeIp: number,
	propertyIp: number,
	propertyDst: number,
): { registers: Array<number>; moveIps: ReadonlySet<number> } | null {
	const registers = new Set<number>([propertyDst]);
	let changed = true;
	while (changed) {
		changed = false;
		for (let ip = headerIp; ip <= backedgeIp; ip++) {
			const instruction = fn.instructions[ip]!;
			if (
				instruction.opcode === "MOVE" &&
				registers.has(instruction.src) &&
				!registers.has(instruction.dst)
			) {
				registers.add(instruction.dst);
				changed = true;
			}
		}
	}
	if ([...registers].some((register) => reps[register] !== "boxed")) return null;

	const moveIps = new Set<number>();
	for (let ip = headerIp; ip <= backedgeIp; ip++) {
		const instruction = fn.instructions[ip]!;
		if (ip === propertyIp) continue;
		if (
			instruction.opcode === "MOVE" &&
			registers.has(instruction.src) &&
			registers.has(instruction.dst)
		) {
			moveIps.add(ip);
			continue;
		}
		if (loopTwinReadRegisters(instruction).some((register) => registers.has(register))) {
			return null;
		}
		if (writeRegisters(instruction).some((register) => registers.has(register))) {
			return null;
		}
	}
	return { registers: [...registers].sort((left, right) => left - right), moveIps };
}

function materializeDeferredInheritedValue(twin: InheritedLoadLoopTwin): Array<string> {
	if (twin.deferredRegisters.length === 0) return [];
	return [
		`if (${twin.loadedName}) {`,
		...twin.deferredRegisters.map(
			(register) => `  r${register} = __property_ic[${twin.icIndex}].value;`,
		),
		`}`,
	];
}

function inheritedLoadLoopSummary(
	fn: VmFunction,
	reps: Array<RegisterRep>,
	headerIp: number,
	backedgeIp: number,
	propertyIp: number,
	deferred: ReturnType<typeof deferredInheritedMoveChain>,
): InheritedLoadLoopSummary | undefined {
	// Match the actual canonical lowering, including the initialization and both
	// arms of the loop test. Keeping this positional proof exact makes it clear
	// that no skipped instruction can observe an iteration.
	const initialize = fn.instructions[headerIp - 2];
	const preheader = fn.instructions[headerIp - 1];
	const compare = fn.instructions[headerIp];
	const enter = fn.instructions[headerIp + 1];
	const exit = fn.instructions[headerIp + 2];
	const increment = fn.instructions[backedgeIp - 1];
	if (
		initialize?.opcode !== "CREATE_NUMBER" ||
		initialize.value !== 0 ||
		preheader?.opcode !== "JUMP" ||
		preheader.targetIp !== headerIp ||
		compare?.opcode !== "BINARY" ||
		compare.operator !== "<" ||
		compare.left !== initialize.dst ||
		enter?.opcode !== "JUMP_IF" ||
		enter.cond !== compare.dst ||
		enter.targetIp !== propertyIp ||
		exit?.opcode !== "JUMP" ||
		exit.targetIp <= backedgeIp ||
		propertyIp !== headerIp + 3 ||
		increment?.opcode !== "UNARY" ||
		increment.operator !== "increment" ||
		increment.src !== initialize.dst ||
		increment.dst !== initialize.dst ||
		deferred === null ||
		reps[initialize.dst] !== "number" ||
		reps[compare.right] !== "number" ||
		reps[compare.dst] !== "boolean"
	) {
		return undefined;
	}

	// No edge or handler may reach the preheader after bypassing the adjacent
	// zero initialization. Edges to the initializer itself remain safe.
	if (
		fn.instructions.some(
			(instruction) =>
				(instruction.opcode === "JUMP" || instruction.opcode === "JUMP_IF") &&
				instruction.targetIp === headerIp - 1,
		) ||
		fn.handlers.some((handler) => handler.handlerIp === headerIp - 1)
	) {
		return undefined;
	}

	// Between the load and unit increment, its result may only flow through the
	// already-proved deferred MOVE chain. This also excludes extra arithmetic or
	// any other body work even when the general loop twin could clone it safely.
	for (let ip = propertyIp + 1; ip < backedgeIp - 1; ip++) {
		if (!deferred.moveIps.has(ip)) return undefined;
	}
	if (
		fn.instructions
			.slice(headerIp, backedgeIp + 1)
			.some((instruction) => writeRegisters(instruction).includes(compare.right))
	) {
		return undefined;
	}

	return {
		index: initialize.dst,
		bound: compare.right,
		condition: compare.dst,
		exitIp: exit.targetIp,
	};
}

/**
 * Find the first deliberately small loop-twin domain. Requiring a literal
 * flattened interval, one preheader edge, one unconditional backedge, and no
 * handler/resume/observable instruction makes cloning mechanically exact. This
 * is a proof-oriented seed, not an attempt to recognize every reducible loop.
 */
function findInheritedLoadLoopTwins(
	fn: VmFunction,
	reps: Array<RegisterRep>,
	coro: CoroutineContext | null,
): Array<InheritedLoadLoopTwin> {
	if (coro !== null) return [];

	const candidates: Array<InheritedLoadLoopTwin> = [];
	for (let backedgeIp = 0; backedgeIp < fn.instructions.length; backedgeIp++) {
		const backedge = fn.instructions[backedgeIp]!;
		if (backedge.opcode !== "JUMP" || backedge.targetIp >= backedgeIp) continue;
		const headerIp = backedge.targetIp;
		if (headerIp <= 0) continue;
		const preheader = fn.instructions[headerIp - 1];
		if (preheader?.opcode !== "JUMP" || preheader.targetIp !== headerIp) continue;

		// The interval must have exactly one backedge and no entry except the
		// immediately preceding preheader jump. Forward exits remain legal.
		let exactControlFlow = true;
		for (let sourceIp = 0; sourceIp < fn.instructions.length; sourceIp++) {
			const instruction = fn.instructions[sourceIp]!;
			if (instruction.opcode !== "JUMP" && instruction.opcode !== "JUMP_IF") {
				continue;
			}
			const target = instruction.targetIp;
			if (
				sourceIp >= headerIp &&
				sourceIp <= backedgeIp &&
				target <= sourceIp &&
				!(sourceIp === backedgeIp && target === headerIp)
			) {
				exactControlFlow = false;
				break;
			}
			if (
				(sourceIp < headerIp || sourceIp > backedgeIp) &&
				target >= headerIp &&
				target <= backedgeIp &&
				!(sourceIp === headerIp - 1 && target === headerIp)
			) {
				exactControlFlow = false;
				break;
			}
		}
		if (!exactControlFlow) continue;
		if (
			fn.handlers.some(
				(handler) =>
					(handler.handlerIp >= headerIp && handler.handlerIp <= backedgeIp) ||
					Math.max(handler.startIp, headerIp) < Math.min(handler.endIp, backedgeIp + 1),
			)
		) {
			continue;
		}

		const loads: Array<{
			ip: number;
			instruction: Extract<VmInstruction, { opcode: "LOAD_PROPERTY_STATIC" }>;
		}> = [];
		let scalarOnly = true;
		for (let ip = headerIp; ip <= backedgeIp; ip++) {
			const instruction = fn.instructions[ip]!;
			if (instruction.opcode === "LOAD_PROPERTY_STATIC") {
				loads.push({ ip, instruction });
				continue;
			}
			if (
				!LOOP_TWIN_SCALAR_OPCODES.has(instruction.opcode) ||
				nativeInstructionMayInvalidateSemanticEpoch(instruction, reps)
			) {
				scalarOnly = false;
				break;
			}
		}
		if (!scalarOnly || loads.length !== 1) continue;
		const load = loads[0]!;
		if (
			load.instruction.nativeCardinalityAccess !== undefined ||
			(fn.stackObjectAccesses ?? []).some(
				(access) => access.instructionIndex === load.ip,
			) ||
			(fn.stackObjectInheritedAccesses ?? []).some(
				(access) => access.instructionIndex === load.ip,
			)
		) {
			continue;
		}
		if (reps[load.instruction.object] !== "boxed") continue;
		if (
			fn.instructions
				.slice(headerIp, backedgeIp + 1)
				.some((instruction) =>
					writeRegisters(instruction).includes(load.instruction.object),
				)
		) {
			continue;
		}
		const deferred = deferredInheritedMoveChain(
			fn,
			reps,
			headerIp,
			backedgeIp,
			load.ip,
			load.instruction.dst,
		);
		const summary = inheritedLoadLoopSummary(
			fn,
			reps,
			headerIp,
			backedgeIp,
			load.ip,
			deferred,
		);

		candidates.push({
			headerIp,
			backedgeIp,
			propertyIp: load.ip,
			receiver: load.instruction.object,
			icIndex: load.instruction.icIndex,
			probeName: `__inherited_loop_${headerIp}_probe`,
			position: fn.positions[load.ip] ?? -1,
			deferredRegisters: deferred?.registers ?? [],
			deferredMoveIps: deferred?.moveIps ?? new Set<number>(),
			loadedName: `__inherited_loop_${headerIp}_loaded`,
			summary,
		});
	}

	// Nested/overlapping intervals need a real loop forest. Fail closed until that
	// structure exists rather than composing ad-hoc clone label namespaces.
	return candidates.filter(
		(candidate, index) =>
			!candidates.some(
				(other, otherIndex) =>
					index !== otherIndex &&
					Math.max(candidate.headerIp, other.headerIp) <=
						Math.min(candidate.backedgeIp, other.backedgeIp),
			),
	);
}

interface DenseIteratorCursor {
	name: string;
	iterator: number;
	next: number;
}

interface DenseIteratorCursorAction {
	cursor: DenseIteratorCursor;
	kind: "capture" | "step";
}

interface StackObjectSite {
	objectName: string;
	slotsOffset: number;
	slotCount: number;
	inheritedLoadInstructionIndex?: number;
	inheritedIcIndex?: number;
	inheritedFastName?: string;
	inheritedValueName?: string;
	inheritedGuard?: VmGuardPlan;
	cardinalityRegion?: CardinalityRegion;
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

function closedGlobalTableAdmissionGuard(guard: VmGuardPlan): string {
	if (
		!guard.obligations.includes("fallback") ||
		!guard.obligations.includes("materialize")
	) {
		throw new Error("Closed-global table lacks its fallback contract");
	}
	return semanticDependencyAdmissionGuard(guard);
}

interface FiniteRecordRegion {
	allocationInstructionIndex: number;
	slotsOffset: number;
	slotCount: number;
	fastName: string;
}

/** A serialized numeric reduce plan anchored where its ordinary loop initializes
 * the accumulator. A local miss emits that move and continues unchanged. */
type NumericHofRegionSite = NonNullable<VmFunction["nativeNumericHofRegions"]>[number];

/** The C expression each proven Math operation lowers to, and the bit that proves
 * the corresponding builtin is still installed. Every expression must stay
 * identical to that builtin's own (MAL_BUILTIN_MATH_UNARY in builtin_math.c);
 * the fold's whole claim is that it computes what the call would have. */
const NUMERIC_FOLD_MATH_OPS: ReadonlyMap<
	MathUnaryOperationKey,
	{ expression: (value: string) => string }
> = new Map([
	["abs", { expression: (value) => `fabs(${value})` }],
	["floor", { expression: (value) => `floor(${value})` }],
	["ceil", { expression: (value) => `ceil(${value})` }],
	[
		"round",
		{
			expression: (value) =>
				`mal_builtin_math_unary_number_known(MAL_MATH_UNARY_ROUND, ${value})`,
		},
	],
	["trunc", { expression: (value) => `trunc(${value})` }],
	["sqrt", { expression: (value) => `sqrt(${value})` }],
	["cbrt", { expression: (value) => `cbrt(${value})` }],
	[
		"sign",
		{
			expression: (value) =>
				`(isnan(${value}) ? NAN : (${value} > 0 ? 1 : (${value} < 0 ? -1 : ${value})))`,
		},
	],
	["log", { expression: (value) => `log(${value})` }],
	["log2", { expression: (value) => `log2(${value})` }],
	["log10", { expression: (value) => `log10(${value})` }],
	["exp", { expression: (value) => `exp(${value})` }],
	["sin", { expression: (value) => `sin(${value})` }],
	["cos", { expression: (value) => `cos(${value})` }],
	["tan", { expression: (value) => `tan(${value})` }],
	["asin", { expression: (value) => `asin(${value})` }],
	["acos", { expression: (value) => `acos(${value})` }],
	["atan", { expression: (value) => `atan(${value})` }],
	["sinh", { expression: (value) => `sinh(${value})` }],
	["cosh", { expression: (value) => `cosh(${value})` }],
	["tanh", { expression: (value) => `tanh(${value})` }],
	["asinh", { expression: (value) => `asinh(${value})` }],
	["acosh", { expression: (value) => `acosh(${value})` }],
	["atanh", { expression: (value) => `atanh(${value})` }],
	["log1p", { expression: (value) => `log1p(${value})` }],
	["expm1", { expression: (value) => `expm1(${value})` }],
	["fround", { expression: (value) => `(f64) (float) (${value})` }],
]);

/**
 * Straight-line native arithmetic for one proven numeric `reduce` region. The
 * ordinary guarded loop this replaces reads every element through HasProperty +
 * Get and calls the callback, whose Math operations each re-resolve an
 * inline-cached property and re-prove the native callback; the plan is exactly
 * that callback as f64 code.
 *
 * Nothing is written and nothing is observable until the fold completes, so a
 * non-Number element simply abandons the attempt and lets the untouched region
 * produce the result. A completed fold writes the accumulator and rejoins the
 * region at its accumulator read, leaving the result register, the source
 * position, and every later instruction exactly as they were.
 *
 * Returns null when a register representation leaves nothing to prove — the
 * region then emits as if it had never been admitted.
 */
function emitNumericFoldRegion(
	region: NumericHofRegionSite,
	reps: Array<RegisterRep>,
): Array<string> | null {
	if (reps[region.receiver] !== "boxed" || reps[region.accumulator] === "boolean") {
		return null;
	}
	const prefix = `__fold_${region.entryIp}`;
	const accumulator = `${prefix}_accumulator`;
	const element = `${prefix}_element`;
	const operand = (value: number): string =>
		value === NUMERIC_HOF_INPUT_ACCUMULATOR
			? accumulator
			: value === NUMERIC_HOF_INPUT_ELEMENT
				? element
				: `${prefix}_op${value}`;
	const plan: Array<string> = [];
	for (const [index, operation] of region.operations.entries()) {
		const name = `${prefix}_op${index}`;
		if (operation.type === "constant") {
			plan.push(`f64 ${name} = ${cF64Literal(operation.value)};`);
		} else if (operation.type === "binary") {
			const expression = nativeNumberExpr(
				operation.operator,
				operand(operation.left),
				operand(operation.right),
			);
			if (expression === null) return null;
			plan.push(`f64 ${name} = ${expression};`);
		} else {
			const math = NUMERIC_FOLD_MATH_OPS.get(operation.operation);
			if (math === undefined) return null;
			plan.push(`f64 ${name} = ${math.expression(operand(operation.value))};`);
		}
	}
	const mathCalls = region.operations.filter(
		(operation) => operation.type === "math",
	).length;
	const initialValue = cF64Literal(region.initialValue);
	const foldedResult =
		reps[region.accumulator] === "number"
			? accumulator
			: `mal_ops_number_value(${accumulator})`;
	return [
		`{`,
		`  const MalValue *${prefix}_elements;`,
		`  u32 ${prefix}_length;`,
		`  if (${regionAdmissionGuard(region.license)} && mal_builtin_array_numeric_fold_local_admit(vm, r${region.receiver}, &${prefix}_elements, &${prefix}_length)) {`,
		`    f64 ${accumulator} = ${initialValue};`,
		`    u32 ${prefix}_index = 0;`,
		`    for (; ${prefix}_index < ${prefix}_length; ${prefix}_index++) {`,
		`      MalValue ${prefix}_boxed = ${prefix}_elements[${prefix}_index];`,
		`      if (!mal_ops_is_number(${prefix}_boxed)) break;`,
		`      f64 ${element} = mal_ops_number_as_f64(${prefix}_boxed);`,
		...plan.map((line) => `      ${line}`),
		`      ${accumulator} = ${operand(region.resultOperand)};`,
		`    }`,
		`    mal_perf_numeric_fold_region(${prefix}_index, ${prefix}_length, ${mathCalls});`,
		`    if (${prefix}_index == ${prefix}_length) {`,
		`      r${region.accumulator} = ${foldedResult};`,
		`      if (mal_gc_poll) mal_gc_safepoint(vm);`,
		`      goto L${region.completionIp};`,
		`    }`,
		`  }`,
		`}`,
	];
}

interface CardinalityRegion {
	allocationInstructionIndex: number;
	arrayRegister: number;
	maximumLength: number;
	license: VmRegionLicense;
	/** Every instruction in the complete virtual lifetime is unable to run JS or
	 * invalidate either semantic family, so admission licenses all later uses. */
	semanticEpochStable: boolean;
	epochName: string;
	itemSite: StackObjectSite;
	itemRegister: number;
	itemShapeCacheIndex: number;
	itemKeyStringIndices: Array<number>;
	historySlotsOffset: number;
	fastName: string;
	countName: string;
	shapeName: string;
	currentMaterializedName: string;
	elementIndexName: string;
}

function cardinalityAdmissionGuard(region: CardinalityRegion): string {
	const semantic = regionAdmissionGuard(
		region.license,
		region.semanticEpochStable ? undefined : region.epochName,
	);
	return vmGuardIsWorldInvariant(region.license.guard)
		? semantic
		: `${semantic} && mal_builtin_array_push_virtual_guard(vm)`;
}

/**
 * Hoisted state for a consolidated (polymorphic) object region: up to
 * MAL_OBJECT_REGION_MAX_SHAPES cached variant shapes, the shared per-access keys, and the
 * per-variant slot table (statics, so they persist across calls like an IC), plus the object
 * pointer, the matched variant index `_v` (-1 = miss), and the `_ok` flag. Emitted once, at
 * the run's first access. Real code is often polymorphic at a site; caching a few shapes lets
 * the run stay consolidated instead of deopting to the per-access ICs on every other shape.
 */
function consolidatedRegionDeclare(reg: RegionAccess, objExpr: string): Array<string> {
	return [
		`MalObjectRegionCache *${reg.name}_c = vm->property_cache[__property_function_index].regions[${reg.leadingIcIndex}];`,
		`MalObject *${reg.name}_o = mal_vm_as_object(${objExpr});`,
		// Resolve the matched variant's slot row to a pointer ONCE (offset amortized over the
		// run), so each access is a direct `_slp[i]` — no per-access multiply. The primary
		// variant (index 0 — the monomorphic / dominant shape) is a single compare to the base
		// row, so the common case costs exactly the monomorphic form; only other shapes scan.
		`const u32 *${reg.name}_slp;`,
		`int ${reg.name}_v;`,
		`if (${reg.name}_c && ${reg.name}_o && ${reg.name}_o->shape == ${reg.name}_c->shapes[0]) {`,
		`  ${reg.name}_v = 0;`,
		`  ${reg.name}_slp = ${reg.name}_c->slots;`,
		`} else {`,
		`  ${reg.name}_v = ${reg.name}_c && ${reg.name}_o ? mal_vm_object_region_variant(${reg.name}_o->shape, ${reg.name}_c->shapes, ${reg.name}_c->count) : -1;`,
		`  ${reg.name}_slp = ${reg.name}_v >= 0 ? &${reg.name}_c->slots[${reg.name}_v * ${reg.size}] : nullptr;`,
		`}`,
		`bool ${reg.name}_ok = ${reg.name}_slp != nullptr;`,
	];
}

/** Revalidate the selected shape before every access after the first. Arbitrary
 * operations between region members can invoke user code that reshapes or
 * dictionarizes the receiver, invalidating both the slot row and slot storage. */
function consolidatedRegionRevalidate(reg: RegionAccess): Array<string> {
	return reg.declare || !reg.revalidate
		? []
		: [
				`${reg.name}_ok = ${reg.name}_slp != nullptr && ${reg.name}_o->shape == ${reg.name}_c->shapes[${reg.name}_v];`,
			];
}

/**
 * Slow-path commit for a consolidated object region, emitted after the run's last access:
 * when the guard missed (`!__rgok`), try to add the object's shape as a new region variant
 * (its per-site ICs having just resolved) so the next matching iteration is consolidated.
 */
function consolidatedRegionCommit(reg: RegionAccess): Array<string> {
	const ptrs = reg.icIndices.map((i) => `&__property_ic[${i}]`).join(", ");
	return [
		`if (!${reg.name}_ok) mal_vm_object_region_add_owned(vm, __property_function_index, ${reg.leadingIcIndex}, ${reg.name}_o, (const MalInlineCache *[]){${ptrs}}, ${reg.size});`,
	];
}

/**
 * Resolve each instruction's innermost exception handler in one sweep. Handler
 * ranges come from balanced TRY markers, so they are disjoint or properly nested.
 */
function exceptionHandlerTargets(
	instructionCount: number,
	handlers: ReadonlyArray<VmExceptionHandler>,
): Array<number | undefined> {
	const ordered = [...handlers].sort(
		(left, right) => left.startIp - right.startIp || right.endIp - left.endIp,
	);
	const active: Array<VmExceptionHandler> = [];
	const targets = new Array<number | undefined>(instructionCount);
	let next = 0;
	for (let ip = 0; ip < instructionCount; ip++) {
		while (active.length > 0 && active[active.length - 1]!.endIp <= ip) active.pop();
		while (next < ordered.length && ordered[next]!.startIp <= ip) {
			const handler = ordered[next++]!;
			const parent = active[active.length - 1];
			if (parent !== undefined && handler.endIp > parent.endIp) {
				throw new Error("Crossing exception-handler ranges");
			}
			active.push(handler);
		}
		targets[ip] = active[active.length - 1]?.handlerIp;
	}
	return targets;
}

/**
 * Emit the instruction body, with labels at jump targets and gotos for jumps.
 * Returns null if any instruction is not yet lowerable.
 */
function emitBody(
	fn: VmFunction,
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
	finiteRecordRegions: ReadonlyMap<number, FiniteRecordRegion>,
	finiteRecordStores: ReadonlyMap<number, FiniteRecordRegion>,
	finiteRecordAccesses: ReadonlyMap<number, FiniteRecordRegion>,
	cardinalityRegions: ReadonlyMap<number, CardinalityRegion>,
	cardinalityAccesses: ReadonlyMap<
		number,
		{
			region: CardinalityRegion;
			role: "push" | "length" | "element" | "field";
			fieldSlot?: number;
		}
	>,
	cardinalityPushes: ReadonlyMap<number, CardinalityRegion>,
	stringSplitProjectionSites: ReadonlyMap<number, NativeStringSplitProjectionSite>,
	stringSplitCursorSites: ReadonlyMap<number, NativeStringSplitCursorSite>,
	regexpExecProjectionSites: ReadonlyMap<number, NativeRegExpExecProjectionSite>,
	regexpIteratorProjectionSites: ReadonlyMap<number, NativeRegExpIteratorProjectionSite>,
	invariantJsonParseCaches: ReadonlyMap<
		number,
		NonNullable<VmFunction["nativeInvariantJsonParseCaches"]>[number] & {
			rootsOffset: number;
		}
	>,
	invariantJsonMapTemplates: ReadonlyMap<
		number,
		NonNullable<VmFunction["nativeInvariantJsonMapTemplates"]>[number] & {
			rootsOffset: number;
		}
	>,
	privateAggregateMemos: ReadonlyMap<
		number,
		NonNullable<VmFunction["nativePrivateAggregateMemos"]>[number] & {
			rootsOffset: number;
		}
	>,
	numericHofRegions: ReadonlyMap<number, NumericHofRegionSite>,
	directCompiledTargets: ReadonlyMap<number, number>,
	watchedMethodsGuard: VmGuardPlan | undefined,
	profileDecisions: Array<BackendProfileDecision>,
): Array<string> | null {
	const jumpTargets = new Set<number>();
	for (const instruction of fn.instructions) {
		if (instruction.opcode === "JUMP" || instruction.opcode === "JUMP_IF") {
			jumpTargets.add(instruction.targetIp);
		}
	}
	// A completed native fold rejoins the ordinary region at its loop-exit target,
	// which is a jump target already unless a later pass straightened that edge.
	for (const region of numericHofRegions.values()) {
		jumpTargets.add(region.completionIp);
	}
	type PrivateAggregateMemoSite =
		typeof privateAggregateMemos extends ReadonlyMap<number, infer Site> ? Site : never;
	const privateAggregateAllocationByIp = new Map<number, PrivateAggregateMemoSite>();
	const privateAggregatePushByIp = new Map<number, PrivateAggregateMemoSite>();
	for (const memo of privateAggregateMemos.values()) {
		privateAggregateAllocationByIp.set(memo.allocationIp, memo);
		for (const pushIp of memo.constructionPushIps) {
			privateAggregatePushByIp.set(pushIp, memo);
		}
	}
	type InvariantJsonMapSite =
		typeof invariantJsonMapTemplates extends ReadonlyMap<number, infer Site>
			? Site
			: never;
	const invariantJsonMapActions = new Map<
		number,
		{ site: InvariantJsonMapSite; role: "parse" | "mapLoad" | "mapCall" }
	>();
	for (const site of invariantJsonMapTemplates.values()) {
		invariantJsonMapActions.set(site.parseCallIp, { site, role: "parse" });
		invariantJsonMapActions.set(site.mapLoadIp, { site, role: "mapLoad" });
		invariantJsonMapActions.set(site.mapCallIp, { site, role: "mapCall" });
	}
	// Static property sites inside a natural flattened loop are the ones where
	// cloning the dependency-registered inherited-value fast path pays for its
	// code size. Mark the union of backward-jump intervals; straight-line and
	// one-shot sites retain the smaller ordinary probe and outlined inherited
	// fallback.
	const loopBody = new Set<number>();
	const loopDeltas = new Int32Array(fn.instructions.length + 1);
	for (let ip = 0; ip < fn.instructions.length; ip++) {
		const instruction = fn.instructions[ip]!;
		if (
			(instruction.opcode === "JUMP" || instruction.opcode === "JUMP_IF") &&
			instruction.targetIp <= ip
		) {
			loopDeltas[instruction.targetIp] = (loopDeltas[instruction.targetIp] ?? 0) + 1;
			loopDeltas[ip + 1] = (loopDeltas[ip + 1] ?? 0) - 1;
		}
	}
	let loopDepth = 0;
	for (let ip = 0; ip < fn.instructions.length; ip++) {
		loopDepth += loopDeltas[ip]!;
		if (loopDepth > 0) loopBody.add(ip);
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
	const inheritedLoadLoopTwins = findInheritedLoadLoopTwins(fn, reps, coro);
	const inheritedLoadLoopTwinByHeader = new Map(
		inheritedLoadLoopTwins.map((twin) => [twin.headerIp, twin] as const),
	);
	const inheritedLoadLoopTwinByBackedge = new Map(
		inheritedLoadLoopTwins.map((twin) => [twin.backedgeIp, twin] as const),
	);
	const closedRecordAccessByIp = new Map<number, { regionId: number; slot: number }>();
	const closedRecordElementLoadIps = new Set<number>();
	const closedRecordRegions = (fn.regions ?? []).filter(
		(region) => region.kind === "closed-record-array",
	);
	for (const instruction of fn.instructions) {
		if (instruction.opcode === "LOAD_PROPERTY") {
			delete instruction.nativeClosedRecordArrayAccess;
		}
	}
	for (const [regionId, region] of closedRecordRegions.entries()) {
		const allocationIp = region.anchors[0]!;
		const producerObjectIp = region.anchors[1]!;
		if (!vmGuardIsWorldInvariant(region.license.guard)) {
			throw new Error("Closed record-Array region lacks a world-invariant license");
		}
		if (
			fn.instructions[allocationIp]?.opcode !== "CREATE_ARRAY" ||
			fn.instructions[producerObjectIp]?.opcode !== "CREATE_OBJECT_SHAPED"
		) {
			throw new Error(`Invalid closed record-Array region ${regionId}`);
		}
		for (const ip of region.elementLoadIps) {
			if (
				fn.instructions[ip]?.opcode !== "LOAD_PROPERTY" ||
				closedRecordElementLoadIps.has(ip)
			) {
				throw new Error(`Overlapping closed record-Array element load at ${ip}`);
			}
			closedRecordElementLoadIps.add(ip);
			const load = fn.instructions[ip];
			if (load.opcode === "LOAD_PROPERTY") {
				load.nativeClosedRecordArrayAccess = { allocationIp };
			}
		}
		for (const access of region.accesses) {
			if (closedRecordAccessByIp.has(access.ip)) {
				throw new Error(`Overlapping closed record-Array access at ${access.ip}`);
			}
			closedRecordAccessByIp.set(access.ip, { regionId, slot: access.slot });
		}
	}

	// Canonical Math calls arrive through the shared builtin-call fact path. The
	// property Get and argument evaluation remain ordinary instructions; this only
	// selects the numeric consumer after identity/effect/result validation in IR.
	const mathUnaryCalls = new Set<number>();
	const mathBinaryCalls = new Set<number>();
	for (let ip = 0; ip < fn.instructions.length; ip++) {
		const instruction = fn.instructions[ip]!;
		if (instruction.opcode !== "CALL") continue;
		const operation = instruction.guardedBuiltinCall?.operation;
		if (operation?.startsWith("Math.") !== true) continue;
		if (operation !== "Math.min" && operation !== "Math.max") {
			if (instruction.arguments.length === 1) mathUnaryCalls.add(ip);
		} else if (instruction.arguments.length === 2) {
			mathBinaryCalls.add(ip);
		}
	}
	const elidedLockedMathGenericTwinIps = new Set<number>();
	for (const site of fn.nativeMathCalls ?? []) {
		const call = fn.instructions[site.callIp];
		const property = fn.instructions[site.propertyIp];
		if (
			call?.opcode !== "CALL" ||
			property?.opcode !== "LOAD_PROPERTY_STATIC" ||
			call.guardedBuiltinCall === undefined ||
			!vmGuardIsWorldInvariant(call.guardedBuiltinCall.guard) ||
			reps[call.dst] !== "number"
		) {
			continue;
		}
		const operation = call.guardedBuiltinCall.operation;
		const nativeOperation =
			call.arguments.length === 1
				? MATH_UNARY_NATIVE_OP.get(operation)
				: MATH_BINARY_NATIVE_OP.get(operation);
		if (nativeOperation === undefined) continue;
		const argumentsAreNative = call.arguments.every((operand) => {
			const decoded = decodeVmValueOperand(operand);
			return (
				decoded.kind === "number" ||
				(decoded.kind === "register" && reps[decoded.register] === "number")
			);
		});
		if (argumentsAreNative) {
			elidedLockedMathGenericTwinIps.add(site.receiverIp);
			elidedLockedMathGenericTwinIps.add(site.propertyIp);
		}
	}

	// A synchronous iterator record captures its `next` method exactly once. When
	// GET_ITERATOR and ITERATOR_STEP retain the same allocated register pair, keep
	// the validated dense Array-values iterator pointer in a native local instead
	// of rechecking object classes, callback identity, kind, and target on every
	// element. The boxed pair remains the GC root; any register overwrite clears
	// the raw nonmoving cursor before it can be reused.
	const denseIteratorCursorActions = new Map<number, DenseIteratorCursorAction>();
	const denseIteratorCursorResets = new Map<number, Array<DenseIteratorCursor>>();
	const denseIteratorCursors: Array<DenseIteratorCursor> = [];
	// A resumable function re-enters through a label after C-local declarations,
	// so a raw cursor local cannot survive suspension. Its boxed iterator record
	// does survive in the coroutine frame; use the regular validated step there.
	if (coro === null) {
		const pairKey = (iterator: number, next: number): string => `${iterator}:${next}`;
		const getPairs = new Set<string>();
		const stepPairs = new Set<string>();
		for (const instruction of fn.instructions) {
			if (instruction.opcode === "GET_ITERATOR") {
				getPairs.add(pairKey(instruction.iteratorDst, instruction.nextDst));
			} else if (instruction.opcode === "ITERATOR_STEP") {
				stepPairs.add(pairKey(instruction.iterator, instruction.next));
			}
		}
		const cursorsByPair = new Map<string, DenseIteratorCursor>();
		for (const key of getPairs) {
			if (!stepPairs.has(key)) continue;
			const [iteratorText, nextText] = key.split(":");
			const cursor: DenseIteratorCursor = {
				name: `__dense_iter_${denseIteratorCursors.length}`,
				iterator: Number(iteratorText),
				next: Number(nextText),
			};
			denseIteratorCursors.push(cursor);
			cursorsByPair.set(key, cursor);
		}

		for (let ip = 0; ip < fn.instructions.length; ip++) {
			const instruction = fn.instructions[ip]!;
			const writes = new Set(writeRegisters(instruction));
			let action: DenseIteratorCursorAction | undefined;
			if (instruction.opcode === "GET_ITERATOR") {
				const cursor = cursorsByPair.get(
					pairKey(instruction.iteratorDst, instruction.nextDst),
				);
				if (cursor !== undefined) action = { cursor, kind: "capture" };
			} else if (instruction.opcode === "ITERATOR_STEP") {
				const cursor = cursorsByPair.get(pairKey(instruction.iterator, instruction.next));
				// If register allocation reuses an iterator/next register for a step
				// result, clear the cursor before the potentially-throwing operation and
				// use the ordinary step path for that site.
				if (
					cursor !== undefined &&
					!writes.has(cursor.iterator) &&
					!writes.has(cursor.next)
				) {
					action = { cursor, kind: "step" };
				}
			}
			if (action !== undefined) denseIteratorCursorActions.set(ip, action);

			const resets = denseIteratorCursors.filter(
				(cursor) => writes.has(cursor.iterator) || writes.has(cursor.next),
			);
			if (resets.length > 0) denseIteratorCursorResets.set(ip, resets);
		}
	}

	// Guarded property-access regions. Group consecutive LOAD/STORE_PROPERTY on the same
	// object register within a straight-line window under one shared receiver guard: an
	// index-form (number-rep key) run guards a dense array (`mal_vm_as_array`), a string-key
	// run guards a plain object (`mal_vm_as_object`). The first access declares the guard
	// local, the rest reuse it, and each access omits the per-access throwCheck on a fast hit
	// (a dense element / a monomorphic data-slot access runs no user code). A run is
	// homogeneous in kind (array vs object need different guards) and bounded by a label
	// (control could enter without passing the guard), a redefinition of the guarded
	// register, or a control-flow terminator. Consolidated object accesses revalidate the
	// selected shape before each later direct slot access, because intervening coercion or
	// calls may reshape/dictionarize the receiver while its identity stays stable.
	const regionGuard = new Map<number, RegionAccess>();
	{
		// First collect maximal runs of same-kind, same-register accesses, then assign each
		// run its region info. A run ends at a label, a redefinition of the accessed
		// register, or a control-flow terminator.
		interface Run {
			reg: number;
			kind: "array" | "object";
			ips: Array<number>;
			closedRegionId?: number;
		}
		const runs: Array<Run> = [];
		let cur: Run | null = null;
		const flush = (): void => {
			if (cur !== null) {
				runs.push(cur);
				cur = null;
			}
		};
		for (let ip = 0; ip < fn.instructions.length; ip++) {
			const instr = fn.instructions[ip]!;
			if (jumpTargets.has(ip)) {
				flush();
			}
			if (
				(instr.opcode === "LOAD_PROPERTY" &&
					instr.nativeClosedGlobalTable === undefined) ||
				(instr.opcode === "STORE_PROPERTY" &&
					instr.nativeClosedGlobalTable === undefined) ||
				instr.opcode === "LOAD_PROPERTY_STATIC" ||
				instr.opcode === "STORE_PROPERTY_STATIC"
			) {
				const kind =
					(instr.opcode === "LOAD_PROPERTY" || instr.opcode === "STORE_PROPERTY") &&
					reps[instr.key] === "number"
						? "array"
						: "object";
				const obj = instr.object;
				const closedRegionId = closedRecordAccessByIp.get(ip)?.regionId;
				if (
					cur !== null &&
					cur.reg === obj &&
					cur.kind === kind &&
					cur.closedRegionId === closedRegionId
				) {
					cur.ips.push(ip);
				} else {
					flush();
					cur = { reg: obj, kind, ips: [ip], closedRegionId };
				}
			}
			// The current access (if any) already read the live guard above; a redefinition
			// of the accessed register now ends the run so later accesses re-guard.
			if (cur !== null && writeRegisters(instr).includes(cur.reg)) {
				flush();
			}
			if (
				instr.opcode === "JUMP" ||
				instr.opcode === "JUMP_IF" ||
				instr.opcode === "RETURN" ||
				instr.opcode === "THROW"
			) {
				flush();
			}
		}
		flush();

		let guardId = 0;
		for (const run of runs) {
			const name = `${run.closedRegionId === undefined ? "__rg" : "__closed_record_"}${guardId++}`;
			// A ≥2-access object run consolidates onto ONE shape guard + a cached-slot array;
			// arrays and single object accesses keep the per-access guarded form.
			const consolidated =
				run.closedRegionId === undefined && run.kind === "object" && run.ips.length >= 2;
			const icIndices = run.ips.map((ip) => {
				const instruction = fn.instructions[ip]!;
				if (
					instruction.opcode !== "LOAD_PROPERTY" &&
					instruction.opcode !== "LOAD_PROPERTY_STATIC" &&
					instruction.opcode !== "STORE_PROPERTY" &&
					instruction.opcode !== "STORE_PROPERTY_STATIC"
				) {
					throw new Error(`Invalid property region instruction ${instruction.opcode}`);
				}
				return instruction.icIndex;
			});
			run.ips.forEach((ip, i) => {
				const closed = closedRecordAccessByIp.get(ip);
				const previousIp = run.ips[i - 1];
				const revalidate =
					consolidated &&
					previousIp !== undefined &&
					fn.instructions
						.slice(previousIp + 1, ip)
						.some((instruction) => nativeInstructionMayCaptureStack(instruction, reps));
				regionGuard.set(ip, {
					name,
					kind: run.kind,
					declare: i === 0,
					consolidated,
					revalidate,
					slotIndex: i,
					size: run.ips.length,
					leadingIcIndex: icIndices[0]!,
					icIndices,
					commit: consolidated && i === run.ips.length - 1,
					closedSlot: closed?.slot,
				});
			});
		}
	}

	const stringCharCodeAtFusionByIp = new Map<number, StringCharCodeAtFusion>();
	for (let loadIp = 0; loadIp + 1 < fn.instructions.length; loadIp++) {
		const load = fn.instructions[loadIp]!;
		const call = fn.instructions[loadIp + 1]!;
		if (
			load.opcode !== "LOAD_PROPERTY_STATIC" ||
			call.opcode !== "CALL" ||
			!vmCallProvesBuiltin(call, "String.prototype.charCodeAt") ||
			call.callee !== load.dst ||
			call.thisValue !== load.object ||
			jumpTargets.has(loadIp + 1) ||
			handlerTargets[loadIp] !== handlerTargets[loadIp + 1] ||
			regionGuard.get(loadIp)?.consolidated === true
		) {
			continue;
		}
		const fusion: StringCharCodeAtFusion = {
			loadIp,
			callIp: loadIp + 1,
			load,
			call,
		};
		stringCharCodeAtFusionByIp.set(loadIp, fusion);
		stringCharCodeAtFusionByIp.set(loadIp + 1, fusion);
	}
	const nativeStringScanRegionActionByIp = new Map<
		number,
		NativeStringScanRegionAction
	>();
	for (const region of fn.nativeStringScanRegions ?? []) {
		nativeStringScanRegionActionByIp.set(region.entryIp, { region, role: "entry" });
		nativeStringScanRegionActionByIp.set(region.lengthLoadIp, { region, role: "length" });
	}
	const nativeStringSplitProjectionActionByIp = new Map<
		number,
		NativeStringSplitProjectionAction
	>();
	for (const site of stringSplitProjectionSites.values()) {
		const propertyInstruction = fn.instructions[site.projection.propertyIp];
		const propertyLoad =
			site.lockedIdentity &&
			site.projection.propertyIp + 1 === site.projection.callIp &&
			propertyInstruction?.opcode === "LOAD_PROPERTY_STATIC" &&
			handlerTargets[site.projection.propertyIp] ===
				handlerTargets[site.projection.callIp]
				? propertyInstruction
				: undefined;
		nativeStringSplitProjectionActionByIp.set(site.projection.callIp, {
			site,
			role: "call",
			propertyLoad,
		});
		if (propertyLoad !== undefined) {
			nativeStringSplitProjectionActionByIp.set(site.projection.propertyIp, {
				site,
				role: "property",
				propertyLoad,
			});
		}
		for (const load of site.projection.loads) {
			nativeStringSplitProjectionActionByIp.set(load.ip, {
				site,
				role: load.kind,
				load,
			});
		}
	}
	const nativeStringSplitCursorActionByIp = new Map<
		number,
		NativeStringSplitCursorAction
	>();
	for (const site of stringSplitCursorSites.values()) {
		const cursor = site.cursor;
		const propertyInstruction = fn.instructions[cursor.propertyIp];
		const propertyLoad =
			site.lockedIdentity &&
			cursor.propertyIp + 1 === site.callIp &&
			propertyInstruction?.opcode === "LOAD_PROPERTY_STATIC" &&
			handlerTargets[cursor.propertyIp] === handlerTargets[site.callIp]
				? propertyInstruction
				: undefined;
		nativeStringSplitCursorActionByIp.set(site.callIp, {
			site,
			role: "call",
			propertyLoad,
		});
		if (propertyLoad !== undefined) {
			nativeStringSplitCursorActionByIp.set(cursor.propertyIp, {
				site,
				role: "property",
				propertyLoad,
			});
		}
		nativeStringSplitCursorActionByIp.set(site.lengthIp, { site, role: "length" });
		nativeStringSplitCursorActionByIp.set(cursor.elementIp, { site, role: "element" });
		nativeStringSplitCursorActionByIp.set(cursor.trimPropertyIp, {
			site,
			role: "trimProperty",
		});
		nativeStringSplitCursorActionByIp.set(cursor.trimCallIp, {
			site,
			role: "trimCall",
		});
	}
	const nativeRegExpExecProjectionActionByIp = new Map<
		number,
		NativeRegExpExecProjectionAction
	>();
	for (const site of regexpExecProjectionSites.values()) {
		const propertyInstruction = fn.instructions[site.projection.propertyIp];
		const propertyLoad =
			site.projection.lockedFreshLiteral &&
			vmGuardIsWorldInvariant(site.projection.license.guard) &&
			site.projection.propertyIp + 1 === site.projection.callIp &&
			propertyInstruction?.opcode === "LOAD_PROPERTY_STATIC" &&
			handlerTargets[site.projection.propertyIp] ===
				handlerTargets[site.projection.callIp]
				? propertyInstruction
				: undefined;
		nativeRegExpExecProjectionActionByIp.set(site.projection.callIp, {
			site,
			role: "call",
			propertyLoad,
		});
		if (propertyLoad !== undefined) {
			nativeRegExpExecProjectionActionByIp.set(site.projection.propertyIp, {
				site,
				role: "property",
				propertyLoad,
			});
		}
		for (const load of site.loads) {
			nativeRegExpExecProjectionActionByIp.set(load.ip, {
				site,
				role: "capture",
				load,
			});
			if (load.consumer?.kind === "length") {
				nativeRegExpExecProjectionActionByIp.set(load.consumer.propertyIp, {
					site,
					role: "length",
					load,
				});
			} else if (load.consumer?.kind === "charCodeAtZero") {
				nativeRegExpExecProjectionActionByIp.set(load.consumer.propertyIp, {
					site,
					role: "charCodeAtProperty",
					load,
				});
				nativeRegExpExecProjectionActionByIp.set(load.consumer.callIp, {
					site,
					role: "charCodeAtCall",
					load,
				});
			} else if (load.consumer?.kind === "number") {
				nativeRegExpExecProjectionActionByIp.set(load.consumer.callIp, {
					site,
					role: "number",
					load,
				});
			} else if (load.consumer?.kind === "asciiCaseLength") {
				for (const [ip, role] of [
					[load.consumer.upperPropertyIp, "caseUpperProperty"],
					[load.consumer.upperCallIp, "caseUpperCall"],
					[load.consumer.lowerPropertyIp, "caseLowerProperty"],
					[load.consumer.lowerCallIp, "caseLowerCall"],
					[load.consumer.lengthPropertyIp, "caseLength"],
				] as const) {
					nativeRegExpExecProjectionActionByIp.set(ip, { site, role, load });
				}
			}
		}
	}
	const nativeRegExpIteratorProjectionActionByIp = new Map<
		number,
		NativeRegExpIteratorProjectionAction
	>();
	for (const site of regexpIteratorProjectionSites.values()) {
		nativeRegExpIteratorProjectionActionByIp.set(site.projection.stepIp, {
			site,
			role: "step",
		});
		for (const load of site.loads) {
			nativeRegExpIteratorProjectionActionByIp.set(load.ip, {
				site,
				role: "capture",
				load,
			});
			nativeRegExpIteratorProjectionActionByIp.set(load.numberCallIp, {
				site,
				role: "number",
				load,
			});
		}
	}
	const nativeStringSliceNumberFusionActionByIp = new Map<
		number,
		NativeStringSliceNumberFusionAction
	>();
	for (const fusion of fn.nativeStringSliceNumberFusions ?? []) {
		const sliceCall = fn.instructions[fusion.sliceCallIp];
		const propertyInstruction = fn.instructions[fusion.propertyIp];
		const lockedIdentity =
			sliceCall?.opcode === "CALL" &&
			sliceCall.guardedBuiltinCall !== undefined &&
			vmGuardIsWorldInvariant(sliceCall.guardedBuiltinCall.guard);
		const propertyLoad =
			lockedIdentity &&
			fusion.propertyIp + 1 === fusion.sliceCallIp &&
			propertyInstruction?.opcode === "LOAD_PROPERTY_STATIC" &&
			handlerTargets[fusion.propertyIp] === handlerTargets[fusion.sliceCallIp]
				? propertyInstruction
				: undefined;
		nativeStringSliceNumberFusionActionByIp.set(fusion.sliceCallIp, {
			fusion,
			role: "slice",
			lockedIdentity,
			propertyLoad,
		});
		if (propertyLoad !== undefined) {
			nativeStringSliceNumberFusionActionByIp.set(fusion.propertyIp, {
				fusion,
				role: "property",
				lockedIdentity,
				propertyLoad,
			});
		}
		nativeStringSliceNumberFusionActionByIp.set(fusion.numberCallIp, {
			fusion,
			role: "number",
			lockedIdentity,
		});
	}

	const lines: Array<string> = denseIteratorCursors.map(
		(cursor) => `MalIteratorObject *${cursor.name} = nullptr;`,
	);
	for (const twin of inheritedLoadLoopTwins) {
		lines.push(`MalValue ${twin.probeName} = MAL_VALUE_UNDEFINED;`);
		if (twin.deferredRegisters.length > 0) {
			lines.push(`bool ${twin.loadedName} = false;`);
		}
	}
	for (const region of fn.nativeStringScanRegions ?? []) {
		lines.push(
			`bool __string_scan_${region.entryIp}_fast = false;`,
			`u32 __string_scan_${region.entryIp}_length = 0;`,
			`u32 __string_scan_${region.entryIp}_matches = 0;`,
		);
	}
	for (const instruction of fn.instructions) {
		if (
			instruction.opcode !== "CONSTRUCT" ||
			instruction.directStringSearchLiteral === undefined
		) {
			continue;
		}
		lines.push(
			`bool __string_search_literal_${instruction.directStringSearchLiteral.callIp}_fast = false;`,
			`MalValue __string_search_literal_${instruction.directStringSearchLiteral.callIp}_result = MAL_VALUE_UNDEFINED;`,
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
	for (const fusion of fn.nativeStringSliceNumberFusions ?? []) {
		lines.push(
			`bool __string_slice_number_${fusion.sliceCallIp}_fast = false;`,
			`f64 __string_slice_number_${fusion.sliceCallIp}_value = 0;`,
		);
	}
	if (
		stringCharCodeAtFusionByIp.size > 0 ||
		[...stringSplitCursorSites.values()].some((site) => !site.lockedIdentity) ||
		[...regexpExecProjectionSites.values()].some((site) =>
			site.loads.some(
				(load) =>
					load.consumer?.kind === "charCodeAtZero" ||
					load.consumer?.kind === "asciiCaseLength",
			),
		) ||
		fn.instructions.some(
			(instruction, ip) =>
				loopBody.has(ip) && instruction.opcode === "LOAD_PROPERTY_STATIC",
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
	for (const instruction of fn.instructions) {
		if (
			instruction.opcode === "BINARY" &&
			instruction.nativeNumericFusion?.role === "start" &&
			reps[instruction.dst] !== "number"
		) {
			const id = instruction.nativeNumericFusion.id;
			lines.push(`bool __nf_${id}_ok = false;`);
			lines.push(`f64 __nf_${id}_value = 0.0;`);
		}
	}
	// Publish source positions only before operations that can synchronously capture
	// this frame. Pure arithmetic/control-flow transitions need no native-frame write.
	let lastPublishedPos = -1;
	let lastPublishedSite = -1;
	for (let ip = 0; ip < fn.instructions.length; ip++) {
		if (jumpTargets.has(ip)) {
			lines.push(`L${ip}:;`);
			// Control can arrive with a different published position.
			lastPublishedPos = -1;
			lastPublishedSite = -1;
		}
		const loopTwin = inheritedLoadLoopTwinByHeader.get(ip);
		if (loopTwin !== undefined) {
			if (loopTwin.deferredRegisters.length > 0) {
				lines.push(`    ${loopTwin.loadedName} = false;`);
			}
			const summary = loopTwin.summary;
			if (summary === undefined) {
				lines.push(
					`    if (${loopTwinValidation(loopTwin)}) goto LF${loopTwin.headerIp};`,
					`    goto LG${loopTwin.headerIp};`,
				);
			} else {
				const bound = `r${summary.bound}`;
				lines.push(
					`    if (${loopTwinValidation(loopTwin)}) {`,
					`      if (mal_gc_preempt_hook == nullptr && ${bound} > 0.0 && isfinite(${bound}) && trunc(${bound}) == ${bound} && ${bound} <= 9007199254740992.0) {`,
					// Model the first iteration before the poll. The ordinary loop polls at
					// its backedge, so a fiber mutation there must leave count=1 with the
					// old value and resume count>1 at index 1 on the generic twin.
					...loopTwin.deferredRegisters.map(
						(register) => `        r${register} = ${loopTwin.probeName};`,
					),
					`        r${summary.index} = 1.0;`,
					"        if (mal_gc_poll) {",
					...(debug && loopTwin.position !== -1
						? [
								`          vm->native_frames[vm->native_frame_count - 1].pos_id = ${loopTwin.position};`,
							]
						: []),
					"          mal_gc_safepoint(vm);",
					`          if (${bound} > 1.0) {`,
					`            if (!${loopTwinValidation(loopTwin)}) goto LG${loopTwin.headerIp};`,
					...loopTwin.deferredRegisters.map(
						(register) => `            r${register} = ${loopTwin.probeName};`,
					),
					"          }",
					"        }",
					`        mal_perf_inherited_loop_summary((u64) ${bound});`,
					`        r${summary.condition} = false;`,
					`        r${summary.index} = ${bound};`,
					`        goto L${summary.exitIp};`,
					"      }",
					`      goto LF${loopTwin.headerIp};`,
					"    }",
					`    goto LG${loopTwin.headerIp};`,
				);
			}
			const fastJumpTargets = new Set<number>([loopTwin.headerIp]);
			for (let fastIp = loopTwin.headerIp; fastIp <= loopTwin.backedgeIp; fastIp++) {
				const instruction = fn.instructions[fastIp]!;
				if (
					(instruction.opcode === "JUMP" || instruction.opcode === "JUMP_IF") &&
					instruction.targetIp >= loopTwin.headerIp &&
					instruction.targetIp <= loopTwin.backedgeIp
				) {
					fastJumpTargets.add(instruction.targetIp);
				}
			}
			for (let fastIp = loopTwin.headerIp; fastIp <= loopTwin.backedgeIp; fastIp++) {
				if (fastJumpTargets.has(fastIp)) lines.push(`LF${fastIp}:;`);
				const fast = elidedLockedMathGenericTwinIps.has(fastIp)
					? []
					: emitInstruction(
							fn.instructions[fastIp]!,
							fastIp,
							suffix,
							reps,
							fn.strict,
							undefined,
							gcUnlink,
							thisSlot,
							coro,
							undefined,
							undefined,
							undefined,
							undefined,
							undefined,
							undefined,
							undefined,
							undefined,
							undefined,
							undefined,
							undefined,
							undefined,
							directCompiledTargets,
							false,
							false,
							true,
							fn.mappedArguments,
							fn.mappedArgumentSlots,
							fn.hasPrototype,
							{ twin: loopTwin, kind: "fast", publishPosition: debug },
						);
				if (fast === null) return null;
				for (const line of fast) lines.push(`    ${line}`);
			}
			lines.push(`LG${loopTwin.headerIp}:;`);
			lastPublishedPos = -1;
			lastPublishedSite = -1;
		}
		for (const cursor of denseIteratorCursorResets.get(ip) ?? []) {
			lines.push(`    ${cursor.name} = nullptr;`);
		}
		const numericHofRegion = numericHofRegions.get(ip);
		if (numericHofRegion !== undefined) {
			for (const line of emitNumericFoldRegion(numericHofRegion, reps) ?? []) {
				lines.push(`    ${line}`);
			}
		}

		const elidedLockedMathGenericTwin = elidedLockedMathGenericTwinIps.has(ip);
		let emitted = elidedLockedMathGenericTwin
			? []
			: emitInstruction(
					fn.instructions[ip]!,
					ip,
					suffix,
					reps,
					fn.strict,
					handlerTargets[ip],
					gcUnlink,
					thisSlot,
					coro,
					denseIteratorCursorActions.get(ip),
					regionGuard.get(ip),
					stackObjectSites.get(ip),
					stackObjectAccesses.get(ip),
					stackObjectMaterializations.get(ip),
					stackObjectInheritedAccesses.get(ip),
					finiteRecordRegions.get(ip),
					finiteRecordStores.get(ip),
					finiteRecordAccesses.get(ip),
					cardinalityRegions.get(ip),
					cardinalityAccesses.get(ip),
					cardinalityPushes.get(ip),
					directCompiledTargets,
					mathUnaryCalls.has(ip),
					mathBinaryCalls.has(ip),
					loopBody.has(ip),
					fn.mappedArguments,
					fn.mappedArgumentSlots,
					fn.hasPrototype,
					inheritedLoadLoopTwinByBackedge.has(ip)
						? {
								twin: inheritedLoadLoopTwinByBackedge.get(ip)!,
								kind: "generic",
								publishPosition: debug,
							}
						: undefined,
					stringCharCodeAtFusionByIp.get(ip),
					nativeStringScanRegionActionByIp.get(ip),
					nativeStringSplitProjectionActionByIp.get(ip),
					nativeStringSplitCursorActionByIp.get(ip),
					nativeRegExpExecProjectionActionByIp.get(ip),
					nativeRegExpIteratorProjectionActionByIp.get(ip),
					nativeStringSliceNumberFusionActionByIp.get(ip),
					invariantJsonParseCaches.get(ip),
					invariantJsonMapActions.get(ip),
					privateAggregateMemos.get(ip),
					privateAggregatePushByIp.get(ip),
				);
		if (emitted === null) {
			return null;
		}
		const jsonMapAction = invariantJsonMapActions.get(ip);
		if (jsonMapAction?.role === "mapLoad") {
			const hit = `__invariant_json_map_${jsonMapAction.site.parseCallIp}_hit`;
			emitted = [`if (!${hit}) {`, ...emitted.map((line) => `  ${line}`), `}`];
		}
		if (
			debug &&
			!elidedLockedMathGenericTwin &&
			nativeInstructionMayCaptureStack(fn.instructions[ip]!, reps)
		) {
			const pos = fn.positions[ip] ?? -1;
			if (pos !== -1 && pos !== lastPublishedPos) {
				lines.push(`    vm->native_frames[vm->native_frame_count - 1].pos_id = ${pos};`);
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
		const allocationMemo = privateAggregateAllocationByIp.get(ip);
		if (allocationMemo !== undefined) {
			const allocation = fn.instructions[ip];
			if (allocation?.opcode !== "CREATE_ARRAY") return null;
			lines.push(
				`    mal_builtin_array_private_aggregate_memo_init(vm, &__private_aggregate_memo_${allocationMemo.callIp}, r${allocation.dst});`,
			);
		}
	}

	return lines;
}

function profileOperationInstruction(instruction: VmInstruction): boolean {
	return profileDecisionOperation(instruction) !== "execute";
}

function profileDecisionOperation(instruction: VmInstruction): string {
	return profileOperationForInstruction(instruction);
}

/** Classify the exact emitted body, after every native specialization pass. */
function profileDecisionsForInstruction(
	instruction: VmInstruction,
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
		if (/mal_compiled_\d+.*_native_numbers\(/.test(source)) {
			decisions.push(
				decision(
					`${operation}.direct-native`,
					source.includes("mal_vm_call_direct(") ? "guarded" : "applied",
					source.includes("mal_vm_call_direct(") ? "callee-identity-guard" : undefined,
				),
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
			/__string_split_|__regexp_exec_|__invariant_json_|__private_aggregate_|mal_builtin_string_search_regexp_direct|mal_builtin_string_slice_to_number/.test(
				source,
			)
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
			/__stack_object_|__finite_record_|__cardinality_|__regexp_exec_|__string_split_|__affine_range_/.test(
				source,
			)
		) {
			decisions.push(
				decision("property.projected", "guarded", "guarded-semantic-fallback"),
			);
		} else if (source.includes("mal_vm_finite_property_")) {
			decisions.push(decision("property.finite-key", "guarded", "finite-key-guard"));
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
		} else if (/__affine_range_|__finite_record_|__cardinality_/.test(source)) {
			decisions.push(
				decision("allocation.virtualized", "guarded", "guarded-materialization"),
			);
		} else if (source.includes("mal_vm_create_object_finite_construction")) {
			decisions.push(
				decision(
					"allocation.finite-shape",
					"retained",
					"runtime-helper-owned-materialization",
				),
			);
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

function profileFallbackFunctions(instruction: VmInstruction): Array<string> {
	const operation = profileDecisionOperation(instruction);
	if (operation === "call" || operation === "construct") {
		return operation === "construct"
			? ["mal_vm_construct_value(", "mal_vm_construct_direct("]
			: ["mal_vm_call_cached(", "mal_vm_call_direct("];
	}
	if (operation === "property") {
		return [
			"mal_vm_array_fast_load_index(",
			"mal_vm_array_fast_store_index(",
			"mal_vm_op_load_property_ic(",
			"mal_vm_op_store_property_ic(",
			"mal_vm_finite_property_load(",
			"mal_vm_finite_property_store(",
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
	instruction: VmInstruction,
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
function emitInstruction(
	instruction: VmInstruction,
	ip: number,
	suffix: string,
	reps: Array<RegisterRep>,
	strict: boolean,
	handlerIp: number | undefined,
	gcUnlink: string,
	thisSlot: number,
	coro: CoroutineContext | null,
	denseIteratorCursor: DenseIteratorCursorAction | undefined,
	region: RegionAccess | undefined,
	stackObjectSite: StackObjectSite | undefined,
	stackObjectAccess: { site: StackObjectSite; slot: number } | undefined,
	stackObjectMaterialization: StackObjectSite | undefined,
	stackObjectInheritedAccess: StackObjectSite | undefined,
	finiteRecordRegion: FiniteRecordRegion | undefined,
	finiteRecordStore: FiniteRecordRegion | undefined,
	finiteRecordAccess: FiniteRecordRegion | undefined,
	cardinalityRegion: CardinalityRegion | undefined,
	cardinalityAccess:
		| {
				region: CardinalityRegion;
				role: "push" | "length" | "element" | "field";
				fieldSlot?: number;
		  }
		| undefined,
	cardinalityPush: CardinalityRegion | undefined,
	directCompiledTargets: ReadonlyMap<number, number>,
	mathUnaryCall: boolean,
	mathBinaryCall: boolean,
	loopStaticPropertyFastPath: boolean,
	mappedArguments: boolean,
	mappedArgumentSlots: Array<number>,
	hasPrototype: boolean,
	loopTwinEmission?: LoopTwinEmission,
	stringCharCodeAtFusion?: StringCharCodeAtFusion,
	nativeStringScanRegionAction?: NativeStringScanRegionAction,
	nativeStringSplitProjectionAction?: NativeStringSplitProjectionAction,
	nativeStringSplitCursorAction?: NativeStringSplitCursorAction,
	nativeRegExpExecProjectionAction?: NativeRegExpExecProjectionAction,
	nativeRegExpIteratorProjectionAction?: NativeRegExpIteratorProjectionAction,
	nativeStringSliceNumberFusionAction?: NativeStringSliceNumberFusionAction,
	invariantJsonParseCache?: NonNullable<
		VmFunction["nativeInvariantJsonParseCaches"]
	>[number] & { rootsOffset: number },
	invariantJsonMapAction?: {
		site: NonNullable<VmFunction["nativeInvariantJsonMapTemplates"]>[number] & {
			rootsOffset: number;
		};
		role: "parse" | "mapLoad" | "mapCall";
	},
	privateAggregateMemo?: NonNullable<
		VmFunction["nativePrivateAggregateMemos"]
	>[number] & { rootsOffset: number },
	privateAggregatePushMemo?: NonNullable<
		VmFunction["nativePrivateAggregateMemos"]
	>[number] & { rootsOffset: number },
): Array<string> | null {
	// Read register r as a boxed MalValue (boxing a number-rep double or a
	// boolean-rep bool).
	const boxed = (r: number): string =>
		reps[r] === "number"
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
				return `mal_value_from_string(&mal_strings${suffix}[${decoded.index}])`;
		}
	};
	const nativeNumberOperand = (operand: number): string | null => {
		const decoded = decodeVmValueOperand(operand);
		if (decoded.kind === "register") {
			return reps[decoded.register] === "number" ? `r${decoded.register}` : null;
		}
		return decoded.kind === "number" ? cF64Literal(decoded.value) : null;
	};
	// Read register r as a raw double (only valid for a number-rep register).
	const num = (r: number): string => `r${r}`;
	// Read register r as a raw C bool (ToBoolean). A boolean-rep register is the
	// bool itself; a number-rep one is truthy iff nonzero and not NaN; a boxed
	// one defers to mal_value_is_truthy.
	const truthy = (r: number): string =>
		reps[r] === "boolean"
			? `r${r}`
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
	const materializeCardinalityRegion = (target: CardinalityRegion): Array<string> => [
		`r${target.arrayRegister} = mal_vm_materialize_virtual_record_array(vm, ${target.shapeName}, &__gc_slots[${target.historySlotsOffset}], ${target.countName}, ${target.itemSite.slotCount});`,
		throwCheck,
		`${target.fastName} = false;`,
		`${target.elementIndexName} = -1;`,
	];
	const cardinalityEpochGuard = (target: CardinalityRegion): string =>
		target.semanticEpochStable
			? ""
			: ` && ${semanticDependencyValidationGuard(target.license.guard, target.epochName)}`;

	// GC safepoint poll. Emitted at call returns and loop
	// back-edges so a compiled function is interruptible for collection. Near-free
	// until the collector raises mal_gc_poll (always false until Phase 3).
	const poll = "if (mal_gc_poll) mal_gc_safepoint(vm);";

	// Where `this` is stored: a derived constructor's is a mutable rooted slot
	// (super() rebinds it); everything else reads the immutable `this_value` param.
	const thisRef = thisSlot >= 0 ? `__gc_slots[${thisSlot}]` : "this_value";

	switch (instruction.opcode) {
		case "MOVE": {
			if (
				loopTwinEmission?.kind === "fast" &&
				loopTwinEmission.twin.deferredMoveIps.has(ip)
			) {
				return [];
			}
			// The dst and src share a rep (a MOVE produces its src's rep, so the
			// dst's join can only differ by being boxed). Read src in the dst's rep.
			const dst = instruction.dst;
			const read =
				reps[dst] === "number"
					? num(instruction.src)
					: reps[dst] === "boolean"
						? truthy(instruction.src)
						: boxed(instruction.src);
			return [`r${dst} = ${read};`];
		}
		case "CREATE_UNDEFINED":
			return [`r${instruction.dst} = MAL_VALUE_UNDEFINED;`];
		case "CREATE_NULL":
			return [`r${instruction.dst} = MAL_VALUE_NULL;`];
		case "CREATE_EMPTY":
			// The TDZ hole sentinel. The dst is always boxed-rep (producedRep
			// defaults it to boxed), so a number/boolean register never holds it.
			return [`r${instruction.dst} = MAL_VALUE_EMPTY;`];
		case "THROW_IF_TDZ":
			// Read-before-initialization check on a let/const/class binding. The
			// helper throws (setting the completion) only on the empty sentinel; a
			// throw propagates out, exactly like the interpreter op.
			return [
				`if (mal_value_is_empty(${boxed(instruction.src)})) {`,
				`  mal_vm_op_throw_if_tdz(vm, ${boxed(instruction.src)}, ${instruction.nameStringIndex});`,
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
				reps[instruction.dst] === "number"
					? `r${instruction.dst} = ${instruction.value};`
					: `r${instruction.dst} = mal_value_from_i32(${instruction.value});`,
			];
		case "CREATE_F64":
			return [
				reps[instruction.dst] === "number"
					? `r${instruction.dst} = ${cF64Literal(instruction.value)};`
					: `r${instruction.dst} = mal_value_from_f64_convert_nan(${cF64Literal(instruction.value)});`,
			];
		case "CREATE_STRING":
			return [
				`r${instruction.dst} = mal_value_from_string(&mal_strings${suffix}[${instruction.stringIndex}]);`,
			];
		case "CREATE_BIGINT":
			return [
				`r${instruction.dst} = mal_value_from_bigint(&mal_bigints${suffix}[${instruction.bigintIndex}]);`,
			];
		case "CREATE_OBJECT":
			if (
				stackObjectSite === undefined &&
				instruction.nativeFiniteConstruction !== undefined
			) {
				const finite = instruction.nativeFiniteConstruction;
				const table = `__finite_construction_keys_${ip}`;
				const guards = finite.numberGuards.map((register) =>
					reps[register] === "number" ? "true" : `mal_ops_is_number(${boxed(register)})`,
				);
				if (finiteRecordRegion !== undefined) {
					return [
						`static const i32 ${table}[] = { ${finite.keyStringIndices.join(", ")} };`,
						`${finiteRecordRegion.fastName} = (${guards.length === 0 ? "true" : guards.join(" && ")}) && mal_vm_prepare_object_finite_construction(vm, ${table}, ${finite.keyStringIndices.length}, &__property_ic[${finite.icIndex}]);`,
						`if (${finiteRecordRegion.fastName}) {`,
						`  r${instruction.dst} = MAL_VALUE_UNDEFINED;`,
						`} else {`,
						`  r${instruction.dst} = mal_vm_op_create_object(vm);`,
						`  ${throwCheck}`,
						`}`,
					];
				}
				return [
					`static const i32 ${table}[] = { ${finite.keyStringIndices.join(", ")} };`,
					`r${instruction.dst} = mal_vm_create_object_finite_construction(vm, ${table}, ${finite.keyStringIndices.length}, ${guards.length === 0 ? "true" : guards.join(" && ")}, &__property_ic[${finite.icIndex}]);`,
					throwCheck,
				];
			}
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
				.map((ki) => `vm->string_constant_atoms[${ki}]`)
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
			const cardinalityReset =
				stackObjectSite.cardinalityRegion === undefined
					? []
					: [`${stackObjectSite.cardinalityRegion.currentMaterializedName} = false;`];
			if (stackObjectSite.inheritedLoadInstructionIndex !== undefined) {
				const fastName = stackObjectSite.inheritedFastName!;
				const inheritedValue = stackObjectSite.inheritedValueName!;
				const icName = `${objectName}_inherited_ic`;
				const prototypeName = `${objectName}_prototype`;
				return [
					...shape,
					...cardinalityReset,
					`MalInlineCache *${icName} = &__property_ic[${stackObjectSite.inheritedIcIndex}];`,
					`MalObject *${prototypeName} = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]);`,
					`${fastName} = ${icName}->mode == MAL_IC_MODE_INHERITED_VALUE && ${icName}->shape == __oshape_${ip} && ((${icName}->poly_count > 0 && ${icName}->proto_object[0] == ${prototypeName}) || (${icName}->poly_count == 0 && ${inheritedStackObjectProtectorGuard(stackObjectSite)} && ${icName}->receiver_type == MAL_HEAP_OBJECT && ${icName}->obj == ${prototypeName}));`,
					`if (${fastName}) {`,
					`  ${inheritedValue} = ${icName}->value;`,
					`  mal_perf_stack_object_init();`,
					`  mal_perf_stack_object_inherited_fast_init();`,
					`  ${objectName} = (MalObject){ .header = MAL_HEAP_HEADER_IMMORTAL(MAL_HEAP_OBJECT), .extensible = true, .shape = __oshape_${ip}, .prototype = ${prototypeName}, .slots = &__gc_slots[${slotsOffset}], .overflow = nullptr };`,
					...instruction.valueRegisters.map(
						(register, index) =>
							`  __gc_slots[${slotsOffset + index}] = ${boxed(register)};`,
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
				...cardinalityReset,
				// Direct initialization is essential: this storage never enters the heap,
				// and IMMORTAL+WHITE makes tracing/finalization/remembering skip the header.
				"mal_perf_stack_object_init();",
				`${objectName} = (MalObject){ .header = MAL_HEAP_HEADER_IMMORTAL(MAL_HEAP_OBJECT), .extensible = true, .shape = __oshape_${ip}, .prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]), .slots = &__gc_slots[${slotsOffset}], .overflow = nullptr };`,
				...instruction.valueRegisters.map(
					(register, index) => `__gc_slots[${slotsOffset + index}] = ${boxed(register)};`,
				),
				`r${instruction.dst} = mal_value_from_object(&${objectName});`,
			];
		}
		case "CREATE_ARRAY":
			if (nativeStringScanRegionAction?.role === "entry") {
				const region = nativeStringScanRegionAction.region;
				const fast = `__string_scan_${region.entryIp}_fast`;
				return [
					`${fast} = mal_vm_try_string_scan_summary(vm, ${boxed(region.input)}, (c16) ${region.matchCodeUnit}, &__string_scan_${region.entryIp}_length, &__string_scan_${region.entryIp}_matches);`,
					`if (${fast}) {`,
					`  r${region.matchResult} = ${reps[region.matchResult] === "number" ? `(f64) __string_scan_${region.entryIp}_matches` : `mal_value_from_i32((i32) __string_scan_${region.entryIp}_matches)`};`,
					`  if (mal_gc_poll) mal_gc_safepoint(vm);`,
					`  goto L${region.exitIp};`,
					`}`,
					`r${instruction.dst} = mal_vm_op_create_array(vm, ${instruction.length});`,
				];
			}
			if (cardinalityRegion !== undefined) {
				const keys = cardinalityRegion.itemKeyStringIndices
					.map((key) => `vm->string_constant_atoms[${key}]`)
					.join(", ");
				return [
					`${cardinalityRegion.shapeName} = __literal_shapes[${cardinalityRegion.itemShapeCacheIndex}];`,
					`if (${cardinalityRegion.shapeName} == nullptr) { ${cardinalityRegion.shapeName} = mal_shape_from_string_keys(&vm->heap, (MalString *[]){ ${keys} }, ${cardinalityRegion.itemSite.slotCount}); __literal_shapes[${cardinalityRegion.itemShapeCacheIndex}] = ${cardinalityRegion.shapeName}; }`,
					`${cardinalityRegion.fastName} = ${cardinalityAdmissionGuard(cardinalityRegion)};`,
					`${cardinalityRegion.countName} = 0;`,
					`${cardinalityRegion.elementIndexName} = -1;`,
					`if (${cardinalityRegion.fastName}) {`,
					`  r${instruction.dst} = MAL_VALUE_UNDEFINED;`,
					`} else {`,
					`  r${instruction.dst} = mal_vm_op_create_array(vm, ${instruction.length});`,
					`  ${throwCheck}`,
					`}`,
				];
			}
			if (instruction.nativeAffineRangeVirtualization?.role === "allocation") {
				const { allocationIp, guard } = instruction.nativeAffineRangeVirtualization;
				if (!guard.obligations.includes("fallback")) {
					throw new Error("Affine range virtualization lacks its generic twin");
				}
				const semanticAdmission = semanticDependencyAdmissionGuard(guard);
				// A future scheduler-enabled version must snapshot array_elements and,
				// after a taken producer poll invalidates it, materialize dense own
				// elements [0, index) before resuming the unchanged next [[Set]].
				// This first slice instead admits only activations that cannot preempt.
				const ordinary = [
					`r${instruction.dst} = mal_vm_op_create_array(vm, ${instruction.length});`,
					...(instruction.nativeFreshDenseReserveLength === undefined
						? []
						: [
								`(void) mal_vm_try_fresh_dense_indexed_fill_reserve(vm, r${instruction.dst}, ${instruction.nativeFreshDenseReserveLength});`,
							]),
				];
				return [
					"MAL_PERF_COUNT(array_affine_range_candidates);",
					`__affine_range_${allocationIp} = mal_gc_preempt_hook == nullptr${semanticAdmission === "true" ? "" : ` && ${semanticAdmission}`};`,
					`if (__affine_range_${allocationIp}) {`,
					`  r${instruction.dst} = MAL_VALUE_UNDEFINED;`,
					"  MAL_PERF_COUNT(array_affine_range_virtualizations);",
					"  MAL_PERF_COUNT(array_affine_range_allocations_elided);",
					`} else {`,
					"  MAL_PERF_COUNT(array_affine_range_guard_fallbacks);",
					...ordinary.map((line) => `  ${line}`),
					`}`,
				];
			}
			if (instruction.nativeFreshDenseReserveLength !== undefined) {
				return [
					`r${instruction.dst} = mal_vm_op_create_array(vm, ${instruction.length});`,
					`(void) mal_vm_try_fresh_dense_indexed_fill_reserve(vm, r${instruction.dst}, ${instruction.nativeFreshDenseReserveLength});`,
				];
			}
			return [`r${instruction.dst} = mal_vm_op_create_array(vm, ${instruction.length});`];
		case "INSTANTIATE_LITERAL_TEMPLATE":
			return [
				`r${instruction.dst} = mal_vm_instantiate_literal_template(vm, ${instruction.templateOffset});`,
				throwCheck,
			];
		case "CREATE_FUNCTION":
			// The closure captures this frame's environment. Only reachable when
			// the enclosing function has no captured slots of its own (see the
			// capturedCount guard in emitCompiledFunction), so `env` — the
			// enclosing function's creation_env — is exactly what its interpreted
			// frame's env would be, making the closure's creation_env correct.
			return [
				`r${instruction.dst} = mal_vm_op_create_function(vm, ${instruction.functionIndex}, env);`,
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
				`r${instruction.dst} = mal_vm_callee_has_index(vm, ${boxed(instruction.callee)}, ${instruction.functionIndex});`,
			];
		case "LOAD_CALLEE":
			// The invoked closure — used to initialize a named function expression's
			// own-name binding. Only emitted in the entry prologue, so `callee` is the
			// fresh-call parameter (a coroutine resume skips the prologue).
			return [`r${instruction.dst} = callee;`];
		case "LOAD_CAPTURED":
			return [
				`r${instruction.dst} = mal_vm_load_captured(env, ${instruction.ownerFunctionIndex}, ${instruction.index});`,
			];
		case "STORE_CAPTURED":
			return [
				`mal_vm_store_captured(env, ${instruction.ownerFunctionIndex}, ${instruction.index}, ${boxed(instruction.src)});`,
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
		case "LOAD_PROPERTY":
		case "LOAD_PROPERTY_STATIC": {
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
					return [
						`MalValue __regexp_exec_${site.projection.callIp}_case_lower_${load.consumer.upperCallIp};`,
						`${fast} = __regexp_exec_${site.projection.callIp}_projected && ${start} >= 0 && mal_vm_local_watched_primitive_value_try_load_static(vm, __watched_methods_epoch, MAL_PRIM_KIND_STRING, &__property_ic[${instruction.icIndex}], &r${instruction.dst}) && mal_vm_local_watched_primitive_value_try_load_static(vm, __watched_methods_epoch, MAL_PRIM_KIND_STRING, &__property_ic[${load.consumer.lowerIcIndex}], &__regexp_exec_${site.projection.callIp}_case_lower_${load.consumer.upperCallIp}) && mal_builtin_string_ascii_case_chain_length_span(vm, r${instruction.dst}, __regexp_exec_${site.projection.callIp}_case_lower_${load.consumer.upperCallIp}, __gc_slots[${site.subjectSlot}], ${start}, ${end}, &${length});`,
						`if (!${fast}) {`,
						`  if (__regexp_exec_${site.projection.callIp}_projected && ${start} >= 0) {`,
						`    __gc_slots[${site.slotsOffset + slot}] = mal_regexp_materialize_capture_span(vm, __gc_slots[${site.subjectSlot}], ${start}, ${end});`,
						`    r${instruction.object} = __gc_slots[${site.slotsOffset + slot}];`,
						`  }`,
						`  r${instruction.dst} = mal_vm_op_load_property_ic(vm, ${boxedOperand(instruction.object)}, mal_value_from_string(vm->string_constant_atoms[${instruction.stringIndex}]), &__property_ic[${instruction.icIndex}]);`,
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
						`  r${instruction.dst} = mal_vm_op_load_property_ic(vm, ${boxedOperand(instruction.object)}, mal_value_from_string(vm->string_constant_atoms[${instruction.stringIndex}]), &__property_ic[${instruction.icIndex}]);`,
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
						`  r${instruction.dst} = mal_vm_op_load_property_ic(vm, ${boxedOperand(instruction.object)}, mal_value_from_string(vm->string_constant_atoms[${instruction.stringIndex}]), &__property_ic[${instruction.icIndex}]);`,
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
						`  r${instruction.dst} = mal_vm_op_load_property_ic(vm, ${boxedOperand(instruction.object)}, mal_value_from_string(vm->string_constant_atoms[${instruction.stringIndex}]), &__property_ic[${instruction.icIndex}]);`,
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
					return [
						`${fast} = false;`,
						`if (__regexp_exec_${site.projection.callIp}_projected && ${start} >= 0 && mal_vm_local_watched_primitive_value_try_load_static(vm, __watched_methods_epoch, MAL_PRIM_KIND_STRING, &__property_ic[${instruction.icIndex}], &r${instruction.dst})) {`,
						`  ${fast} = true;`,
						`} else {`,
						`  if (__regexp_exec_${site.projection.callIp}_projected && ${start} >= 0) {`,
						`    __gc_slots[${site.slotsOffset + slot}] = mal_regexp_materialize_capture_span(vm, __gc_slots[${site.subjectSlot}], ${start}, __regexp_exec_${site.projection.callIp}_ends[${slot}]);`,
						`    r${instruction.object} = __gc_slots[${site.slotsOffset + slot}];`,
						`  }`,
						`  r${instruction.dst} = mal_vm_op_load_property_ic(vm, ${boxedOperand(instruction.object)}, mal_value_from_string(vm->string_constant_atoms[${instruction.stringIndex}]), &__property_ic[${instruction.icIndex}]);`,
						`  ${throwCheck}`,
						`}`,
					];
				}
			}
			if (stringCharCodeAtFusion !== undefined && stringCharCodeAtFusion.loadIp === ip) {
				return [];
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
			if (
				loopTwinEmission?.kind === "fast" &&
				ip === loopTwinEmission.twin.propertyIp &&
				instruction.opcode === "LOAD_PROPERTY_STATIC"
			) {
				if (loopTwinEmission.twin.deferredRegisters.length > 0) {
					return [
						"mal_perf_ic_load_inherited_hit();",
						`${loopTwinEmission.twin.loadedName} = true;`,
					];
				}
				return [
					"mal_perf_ic_load_inherited_hit();",
					`r${instruction.dst} = __property_ic[${instruction.icIndex}].value;`,
				];
			}
			if (
				instruction.opcode === "LOAD_PROPERTY" &&
				instruction.nativeClosedGlobalTable !== undefined
			) {
				const table = instruction.nativeClosedGlobalTable;
				const fallback = emitInstruction(
					{ ...instruction, nativeClosedGlobalTable: undefined },
					ip,
					suffix,
					reps,
					strict,
					handlerIp,
					gcUnlink,
					thisSlot,
					coro,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					directCompiledTargets,
					mathUnaryCall,
					mathBinaryCall,
					loopStaticPropertyFastPath,
					mappedArguments,
					mappedArgumentSlots,
					hasPrototype,
				);
				if (fallback === null) return null;
				const state = `vm->globals[${table.stateIndex}]`;
				const deopt = `mal_vm_closed_global_table_deopt(vm, ${boxed(instruction.object)}, ${table.baseIndex}, ${table.mask + 1}, ${table.stateIndex});`;
				if (!table.direct) {
					return [deopt, throwCheck, ...fallback];
				}
				const value = `__closed_global_value_${ip}`;
				const semanticAdmission = closedGlobalTableAdmissionGuard(table.guard);
				return [
					`if (mal_value_is_undefined(${state}) && ${semanticAdmission}) { for (i32 __i = 0; __i < ${table.mask + 1}; __i++) vm->globals[${table.baseIndex} + __i] = MAL_VALUE_EMPTY; ${state} = MAL_VALUE_FALSE; }`,
					`if (${state} == MAL_VALUE_FALSE && ${semanticAdmission}) {`,
					`  MalValue ${value} = vm->globals[${table.baseIndex} + (i32) ${num(instruction.key)}];`,
					`  r${instruction.dst} = mal_value_is_empty(${value}) ? MAL_VALUE_UNDEFINED : ${value};`,
					`} else {`,
					`  ${deopt}`,
					`  ${throwCheck}`,
					...fallback.map((line) => `  ${line}`),
					`}`,
				];
			}
			if (
				instruction.opcode === "LOAD_PROPERTY" &&
				(instruction.nativeExactFreshArrayAccess !== undefined ||
					instruction.nativeClosedRecordArrayAccess !== undefined)
			) {
				if (reps[instruction.key] !== "number") return null;
				const array = `__exact_fresh_array_${ip}`;
				return [
					`MalArrayObject *${array} = mal_value_to_array_object(${boxed(instruction.object)});`,
					`if (${array}->elements != nullptr) {`,
					`  r${instruction.dst} = ${array}->elements[(u32) ${num(instruction.key)}];`,
					`} else {`,
					`  r${instruction.dst} = mal_vm_array_fast_load_index(vm, ${boxed(instruction.object)}, ${num(instruction.key)}, &__property_ic[${instruction.icIndex}]);`,
					`  ${throwCheck}`,
					`}`,
				];
			}
			if (cardinalityAccess !== undefined) {
				const target = cardinalityAccess.region;
				const fallback = emitInstruction(
					instruction,
					ip,
					suffix,
					reps,
					strict,
					handlerIp,
					gcUnlink,
					thisSlot,
					coro,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					directCompiledTargets,
					mathUnaryCall,
					mathBinaryCall,
					loopStaticPropertyFastPath,
					mappedArguments,
					mappedArgumentSlots,
					hasPrototype,
				);
				if (fallback === null) return null;
				if (cardinalityAccess.role === "length") {
					const countValue =
						reps[instruction.dst] === "number"
							? `(f64) ${target.countName}`
							: `mal_value_from_i32((i32) ${target.countName})`;
					return [
						`if (${target.fastName}) {`,
						`  r${instruction.dst} = ${countValue};`,
						`} else {`,
						...fallback.map((line) => `  ${line}`),
						`}`,
					];
				}
				if (cardinalityAccess.role === "field") {
					const slot = cardinalityAccess.fieldSlot;
					if (slot === undefined || slot < 0 || slot >= target.itemSite.slotCount) {
						return null;
					}
					return [
						`if (${target.elementIndexName} >= 0) {`,
						`  r${instruction.dst} = __gc_slots[${target.historySlotsOffset} + ${target.elementIndexName} * ${target.itemSite.slotCount} + ${slot}];`,
						`} else {`,
						...fallback.map((line) => `  ${line}`),
						`}`,
					];
				}
				if (cardinalityAccess.role === "element") {
					if (instruction.opcode !== "LOAD_PROPERTY") return null;
					const key = instruction.key;
					const keyIsNumber =
						reps[key] === "number" ? "true" : `mal_ops_is_number(${boxed(key)})`;
					const index = `__cardinality_${ip}_index`;
					const valid = `__cardinality_${ip}_index_valid`;
					return [
						`f64 ${index} = 0;`,
						`bool ${valid} = ${target.fastName}${cardinalityEpochGuard(target)} && ${keyIsNumber};`,
						`if (${valid}) { ${index} = ${num(key)}; ${valid} = ${index} >= 0 && ${index} < (f64) ${target.countName} && ${index} == trunc(${index}); }`,
						`if (${valid}) {`,
						`  ${target.elementIndexName} = (i32) ${index};`,
						`  r${instruction.dst} = MAL_VALUE_UNDEFINED;`,
						`} else {`,
						`  if (${target.fastName}) {`,
						...materializeCardinalityRegion(target).map((line) => `    ${line}`),
						...(instruction.object === target.arrayRegister
							? []
							: [`    r${instruction.object} = r${target.arrayRegister};`]),
						`  }`,
						`  ${target.elementIndexName} = -1;`,
						...fallback.map((line) => `  ${line}`),
						`}`,
					];
				}
				return [
					`if (${target.fastName}${cardinalityEpochGuard(target)}) {`,
					`  r${instruction.dst} = vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE_PUSH];`,
					`} else {`,
					`  if (${target.fastName}) {`,
					...materializeCardinalityRegion(target).map((line) => `    ${line}`),
					`  }`,
					...fallback.map((line) => `  ${line}`),
					`}`,
				];
			}
			if (stackObjectInheritedAccess !== undefined) {
				const fallback = emitInstruction(
					instruction,
					ip,
					suffix,
					reps,
					strict,
					handlerIp,
					gcUnlink,
					thisSlot,
					coro,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					directCompiledTargets,
					mathUnaryCall,
					mathBinaryCall,
					loopStaticPropertyFastPath,
					mappedArguments,
					mappedArgumentSlots,
					hasPrototype,
				);
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
				if (site.cardinalityRegion !== undefined) {
					const fallback = emitInstruction(
						instruction,
						ip,
						suffix,
						reps,
						strict,
						handlerIp,
						gcUnlink,
						thisSlot,
						coro,
						undefined,
						undefined,
						undefined,
						undefined,
						undefined,
						undefined,
						undefined,
						undefined,
						undefined,
						undefined,
						undefined,
						undefined,
						directCompiledTargets,
						mathUnaryCall,
						mathBinaryCall,
						loopStaticPropertyFastPath,
						mappedArguments,
						mappedArgumentSlots,
						hasPrototype,
					);
					if (fallback === null) return null;
					return [
						`if (!${site.cardinalityRegion.currentMaterializedName}) {`,
						`  r${instruction.dst} = __gc_slots[${site.slotsOffset + slot}];`,
						`} else {`,
						...fallback.map((line) => `  ${line}`),
						`}`,
					];
				}
				if (site.inheritedLoadInstructionIndex === undefined) {
					return [`r${instruction.dst} = __gc_slots[${site.slotsOffset + slot}];`];
				}
				const fallback = emitInstruction(
					instruction,
					ip,
					suffix,
					reps,
					strict,
					handlerIp,
					gcUnlink,
					thisSlot,
					coro,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					directCompiledTargets,
					mathUnaryCall,
					mathBinaryCall,
					loopStaticPropertyFastPath,
					mappedArguments,
					mappedArgumentSlots,
					hasPrototype,
				);
				if (fallback === null) return null;
				return [
					`if (${site.inheritedFastName}) {`,
					`  r${instruction.dst} = __gc_slots[${site.slotsOffset + slot}];`,
					`} else {`,
					...fallback.map((line) => `  ${line}`),
					`}`,
				];
			}
			if (
				instruction.opcode === "LOAD_PROPERTY" &&
				instruction.nativeFiniteKey !== undefined
			) {
				const finite = instruction.nativeFiniteKey;
				const table = `__finite_property_keys_${ip}`;
				const ordinalNumber =
					reps[finite.ordinal] === "number"
						? num(finite.ordinal)
						: `mal_ops_number_as_f64(${boxed(finite.ordinal)})`;
				const ordinal = `__finite_property_ordinal_${ip}`;
				const object = `__finite_property_object_${ip}`;
				const value = `__v_${ip}`;
				if (finiteRecordAccess !== undefined) {
					return [
						`static const i32 ${table}[] = { ${finite.stringIndices.join(", ")} };`,
						`i32 ${ordinal} = (i32) ${ordinalNumber} - (${finite.minimum});`,
						`if (${finiteRecordAccess.fastName} && ${ordinal} >= 0 && ${ordinal} < ${finiteRecordAccess.slotCount}) {`,
						`  r${instruction.dst} = __gc_slots[${finiteRecordAccess.slotsOffset} + ${ordinal}];`,
						`} else {`,
						`  MalObject *${object} = mal_vm_as_object(${boxed(instruction.object)});`,
						`  MalValue ${value};`,
						`  if (mal_vm_finite_property_try_load(${object}, ${ordinal}, &__property_ic[${instruction.icIndex}], &${value})) {`,
						`    r${instruction.dst} = ${value};`,
						`  } else {`,
						`    r${instruction.dst} = mal_vm_finite_property_load(vm, ${boxed(instruction.object)}, ${boxed(instruction.key)}, ${ordinal}, ${table}, ${finite.stringIndices.length}, &__property_ic[${instruction.icIndex}]);`,
						`    ${throwCheck}`,
						`  }`,
						`}`,
					];
				}
				return [
					`static const i32 ${table}[] = { ${finite.stringIndices.join(", ")} };`,
					`i32 ${ordinal} = (i32) ${ordinalNumber} - (${finite.minimum});`,
					`MalObject *${object} = mal_vm_as_object(${boxed(instruction.object)});`,
					`MalValue ${value};`,
					`if (mal_vm_finite_property_try_load(${object}, ${ordinal}, &__property_ic[${instruction.icIndex}], &${value})) {`,
					`  r${instruction.dst} = ${value};`,
					`} else {`,
					`  r${instruction.dst} = mal_vm_finite_property_load(vm, ${boxed(instruction.object)}, ${boxed(instruction.key)}, ${ordinal}, ${table}, ${finite.stringIndices.length}, &__property_ic[${instruction.icIndex}]);`,
					`  ${throwCheck}`,
					`}`,
				];
			}
			const key =
				instruction.opcode === "LOAD_PROPERTY_STATIC"
					? `mal_value_from_string(vm->string_constant_atoms[${instruction.stringIndex}])`
					: boxed(instruction.key);
			// Per-site monomorphic inline cache (a static, zero-initialized → starts empty).
			// A hit is a direct slot/element read with no shape search or key conversion, and
			// runs no user code — so the guarded-region form drops the throwCheck on the hit
			// path (only the general-IC miss fallback keeps it). One hoisted receiver guard
			// covers the run: an array (mal_vm_as_array) for a number-rep index, a plain
			// object (mal_vm_as_object) for a string key. The hit writes a short-lived temp,
			// not &r${dst}: address-taking the long-lived destination register would pin it to
			// the stack across the whole function; the temp promotes back to a register once
			// the try_* helper inlines.
			const reg: RegionAccess = region ?? {
				name: `__rg_s${ip}`,
				kind:
					instruction.opcode === "LOAD_PROPERTY" && reps[instruction.key] === "number"
						? "array"
						: "object",
				declare: true,
				consolidated: false,
				revalidate: false,
				slotIndex: 0,
				size: 1,
				leadingIcIndex: instruction.icIndex,
				icIndices: [instruction.icIndex],
				commit: false,
			};
			if (reg.closedSlot !== undefined) {
				if (instruction.opcode !== "LOAD_PROPERTY_STATIC") return null;
				return [
					...(reg.declare
						? [
								`MalObject *${reg.name}_o = mal_value_to_object(${boxed(instruction.object)});`,
							]
						: []),
					`r${instruction.dst} = ${reg.name}_o->slots[${reg.closedSlot}];`,
				];
			}
			if (reg.kind === "array" && instruction.opcode === "LOAD_PROPERTY") {
				const ordinary = [
					...(reg.declare
						? [
								`MalArrayObject *${reg.name} = mal_vm_as_array(${boxed(instruction.object)});`,
							]
						: []),
					`MalValue __v_${ip};`,
					`if (${reg.name} && mal_vm_array_try_load(${reg.name}, ${num(instruction.key)}, &__v_${ip})) {`,
					`  r${instruction.dst} = __v_${ip};`,
					`} else {`,
					`  r${instruction.dst} = mal_vm_array_fast_load_index(vm, ${boxed(instruction.object)}, ${num(instruction.key)}, &__property_ic[${instruction.icIndex}]);`,
					`  ${throwCheck}`,
					`}`,
				];
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
				if (instruction.nativeAffineRangeVirtualization?.role === "load") {
					const allocationIp = instruction.nativeAffineRangeVirtualization.allocationIp;
					const direct =
						reps[instruction.dst] === "number"
							? reps[instruction.key] === "number"
								? num(instruction.key)
								: `mal_ops_number_as_f64(${boxed(instruction.key)})`
							: boxed(instruction.key);
					return [
						`if (__affine_range_${allocationIp}) {`,
						`  r${instruction.dst} = ${direct};`,
						`  MAL_PERF_COUNT(array_affine_range_loads_elided);`,
						`} else {`,
						...ordinary.map((line) => `  ${line}`),
						`}`,
					];
				}
				return ordinary;
			}
			if (!reg.consolidated) {
				const probe =
					instruction.opcode === "LOAD_PROPERTY_STATIC"
						? `${
								loopStaticPropertyFastPath
									? `(${reg.name} && mal_vm_object_try_load_static(${reg.name}, &__property_ic[${instruction.icIndex}], &__v_${ip})) || mal_vm_local_inherited_value_try_load_static(${reg.name}, &__property_ic[${instruction.icIndex}], &__v_${ip})`
									: `(${reg.name} && mal_vm_object_try_load_static(${reg.name}, &__property_ic[${instruction.icIndex}], &__v_${ip}))`
							} || ${loopStaticPropertyFastPath ? `mal_vm_local_watched_inherited_value_try_load_static(vm, __watched_methods_epoch, ${boxed(instruction.object)}, &__property_ic[${instruction.icIndex}], &__v_${ip}) || ` : ""}mal_vm_inherited_try_load_static(${boxed(instruction.object)}, &__property_ic[${instruction.icIndex}], &__v_${ip}) || mal_vm_watched_try_load_static(${boxed(instruction.object)}, &__property_ic[${instruction.icIndex}], &__v_${ip}) || mal_vm_special_try_load_static(vm, ${boxed(instruction.object)}, &__property_ic[${instruction.icIndex}], &__v_${ip})`
						: `(${reg.name} && mal_vm_object_try_load(${reg.name}, ${key}, &__property_ic[${instruction.icIndex}], &__v_${ip})) || mal_vm_inherited_try_load(${boxed(instruction.object)}, ${key}, &__property_ic[${instruction.icIndex}], &__v_${ip}) || mal_vm_watched_try_load(${boxed(instruction.object)}, ${key}, &__property_ic[${instruction.icIndex}], &__v_${ip}) || mal_vm_special_try_load(vm, ${boxed(instruction.object)}, ${key}, &__property_ic[${instruction.icIndex}], &__v_${ip})`;
				const ordinary = [
					...(reg.declare
						? [`MalObject *${reg.name} = mal_vm_as_object(${boxed(instruction.object)});`]
						: []),
					`MalValue __v_${ip};`,
					`if (${probe}) {`,
					`  r${instruction.dst} = __v_${ip};`,
					`} else {`,
					`  r${instruction.dst} = mal_vm_op_load_property_ic(vm, ${boxed(instruction.object)}, ${key}, &__property_ic[${instruction.icIndex}]);`,
					`  ${throwCheck}`,
					`}`,
				];
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
				if (nativeStringScanRegionAction?.role === "length") {
					const scan = nativeStringScanRegionAction.region;
					return [
						`if (__string_scan_${scan.entryIp}_fast) {`,
						`  r${scan.lengthResult} = ${reps[scan.lengthResult] === "number" ? `(f64) __string_scan_${scan.entryIp}_length` : `mal_value_from_i32((i32) __string_scan_${scan.entryIp}_length)`};`,
						`} else {`,
						...ordinary.map((line) => `  ${line}`),
						`}`,
					];
				}
				if (
					instruction.opcode === "LOAD_PROPERTY_STATIC" &&
					instruction.nativePrimitiveStringLength === true
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
			// Consolidated object region: one shape guard (__rgok) covers the run; a hit is a
			// direct cached-slot read (key compare guards a computed-key mismatch), a miss the
			// per-access IC. The run's last access commits the cache on the slow path.
			const regionHit =
				instruction.opcode === "LOAD_PROPERTY_STATIC"
					? `${reg.name}_ok`
					: `${reg.name}_ok && ${key} == ${reg.name}_c->keys[${reg.slotIndex}]`;
			return [
				...(reg.declare ? consolidatedRegionDeclare(reg, boxed(instruction.object)) : []),
				...consolidatedRegionRevalidate(reg),
				`MalValue __v_${ip};`,
				`if (${regionHit}) {`,
				`  mal_perf_ic_load_region_hit();`,
				`  __v_${ip} = ${reg.name}_o->slots[${reg.name}_slp[${reg.slotIndex}]];`,
				instruction.opcode === "LOAD_PROPERTY_STATIC"
					? `} else if (mal_vm_special_try_load_static(vm, ${boxed(instruction.object)}, &__property_ic[${instruction.icIndex}], &__v_${ip})) {`
					: `} else if (mal_vm_special_try_load(vm, ${boxed(instruction.object)}, ${key}, &__property_ic[${instruction.icIndex}], &__v_${ip})) {`,
				`} else {`,
				`  __v_${ip} = mal_vm_op_load_property_ic(vm, ${boxed(instruction.object)}, ${key}, &__property_ic[${instruction.icIndex}]);`,
				`  ${throwCheck}`,
				`}`,
				`r${instruction.dst} = __v_${ip};`,
				...(reg.commit ? consolidatedRegionCommit(reg) : []),
			];
		}
		case "STORE_PROPERTY":
		case "STORE_PROPERTY_STATIC": {
			if (
				instruction.opcode === "STORE_PROPERTY" &&
				instruction.nativeClosedGlobalTable !== undefined
			) {
				const table = instruction.nativeClosedGlobalTable;
				const fallback = emitInstruction(
					{ ...instruction, nativeClosedGlobalTable: undefined },
					ip,
					suffix,
					reps,
					strict,
					handlerIp,
					gcUnlink,
					thisSlot,
					coro,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					directCompiledTargets,
					mathUnaryCall,
					mathBinaryCall,
					loopStaticPropertyFastPath,
					mappedArguments,
					mappedArgumentSlots,
					hasPrototype,
				);
				if (fallback === null) return null;
				const state = `vm->globals[${table.stateIndex}]`;
				const deopt = `mal_vm_closed_global_table_deopt(vm, ${boxed(instruction.object)}, ${table.baseIndex}, ${table.mask + 1}, ${table.stateIndex});`;
				if (!table.direct) {
					return [deopt, throwCheck, ...fallback];
				}
				const semanticAdmission = closedGlobalTableAdmissionGuard(table.guard);
				return [
					`if (mal_value_is_undefined(${state}) && ${semanticAdmission}) { for (i32 __i = 0; __i < ${table.mask + 1}; __i++) vm->globals[${table.baseIndex} + __i] = MAL_VALUE_EMPTY; ${state} = MAL_VALUE_FALSE; }`,
					`if (${state} == MAL_VALUE_FALSE && ${semanticAdmission}) {`,
					`  vm->globals[${table.baseIndex} + (i32) ${num(instruction.key)}] = ${boxed(instruction.value)};`,
					`} else {`,
					`  ${deopt}`,
					`  ${throwCheck}`,
					...fallback.map((line) => `  ${line}`),
					`}`,
				];
			}
			if (stackObjectAccess !== undefined) {
				const { site, slot } = stackObjectAccess;
				if (site.cardinalityRegion !== undefined) {
					const fallback = emitInstruction(
						instruction,
						ip,
						suffix,
						reps,
						strict,
						handlerIp,
						gcUnlink,
						thisSlot,
						coro,
						undefined,
						undefined,
						undefined,
						undefined,
						undefined,
						undefined,
						undefined,
						undefined,
						undefined,
						undefined,
						undefined,
						undefined,
						directCompiledTargets,
						mathUnaryCall,
						mathBinaryCall,
						loopStaticPropertyFastPath,
						mappedArguments,
						mappedArgumentSlots,
						hasPrototype,
					);
					if (fallback === null) return null;
					return [
						`if (!${site.cardinalityRegion.currentMaterializedName}) {`,
						`  __gc_slots[${site.slotsOffset + slot}] = ${boxed(instruction.value)};`,
						`} else {`,
						...fallback.map((line) => `  ${line}`),
						`}`,
					];
				}
				return [`__gc_slots[${site.slotsOffset + slot}] = ${boxed(instruction.value)};`];
			}
			if (
				instruction.opcode === "STORE_PROPERTY" &&
				instruction.nativeFiniteKey !== undefined
			) {
				const finite = instruction.nativeFiniteKey;
				const table = `__finite_store_keys_${ip}`;
				const ordinalNumber =
					reps[finite.ordinal] === "number"
						? num(finite.ordinal)
						: `mal_ops_number_as_f64(${boxed(finite.ordinal)})`;
				const ordinal = `__finite_store_ordinal_${ip}`;
				const object = `__finite_store_object_${ip}`;
				if (finiteRecordStore !== undefined) {
					return [
						`static const i32 ${table}[] = { ${finite.stringIndices.join(", ")} };`,
						`i32 ${ordinal} = (i32) ${ordinalNumber} - (${finite.minimum});`,
						`if (${finiteRecordStore.fastName}) {`,
						`  __gc_slots[${finiteRecordStore.slotsOffset} + ${ordinal}] = ${boxed(instruction.value)};`,
						`} else {`,
						`  MalObject *${object} = mal_vm_as_object(${boxed(instruction.object)});`,
						`  if (!mal_vm_finite_property_try_store(${object}, ${ordinal}, ${boxed(instruction.value)}, &__property_ic[${instruction.icIndex}])) {`,
						`    mal_vm_finite_property_store(vm, ${boxed(instruction.object)}, ${boxed(instruction.key)}, ${boxed(instruction.value)}, ${ordinal}, ${table}, ${finite.stringIndices.length}, ${strict}, &__property_ic[${instruction.icIndex}]);`,
						`    ${throwCheck}`,
						`  }`,
						`}`,
					];
				}
				return [
					`static const i32 ${table}[] = { ${finite.stringIndices.join(", ")} };`,
					`i32 ${ordinal} = (i32) ${ordinalNumber} - (${finite.minimum});`,
					`MalObject *${object} = mal_vm_as_object(${boxed(instruction.object)});`,
					`if (!mal_vm_finite_property_try_store(${object}, ${ordinal}, ${boxed(instruction.value)}, &__property_ic[${instruction.icIndex}])) {`,
					`  mal_vm_finite_property_store(vm, ${boxed(instruction.object)}, ${boxed(instruction.key)}, ${boxed(instruction.value)}, ${ordinal}, ${table}, ${finite.stringIndices.length}, ${strict}, &__property_ic[${instruction.icIndex}]);`,
					`  ${throwCheck}`,
					`}`,
				];
			}
			const key =
				instruction.opcode === "STORE_PROPERTY_STATIC"
					? `mal_value_from_string(vm->string_constant_atoms[${instruction.stringIndex}])`
					: boxed(instruction.key);
			// See LOAD_PROPERTY: a monomorphic data-slot/dense-element hit runs no user code,
			// so the region form drops the throwCheck on the hit; the general-[[Set]] miss
			// fallback keeps it. Array (number-rep index) vs plain object (string key).
			const reg: RegionAccess = region ?? {
				name: `__rg_s${ip}`,
				kind:
					instruction.opcode === "STORE_PROPERTY" && reps[instruction.key] === "number"
						? "array"
						: "object",
				declare: true,
				consolidated: false,
				revalidate: false,
				slotIndex: 0,
				size: 1,
				leadingIcIndex: instruction.icIndex,
				icIndices: [instruction.icIndex],
				commit: false,
			};
			if (reg.closedSlot !== undefined) {
				if (instruction.opcode !== "STORE_PROPERTY_STATIC") return null;
				return [
					...(reg.declare
						? [
								`MalObject *${reg.name}_o = mal_value_to_object(${boxed(instruction.object)});`,
							]
						: []),
					`mal_vm_object_slot_store(${reg.name}_o, ${reg.closedSlot}, ${boxed(instruction.value)});`,
				];
			}
			if (reg.kind === "array" && instruction.opcode === "STORE_PROPERTY") {
				const ordinary = [
					...(reg.declare
						? [
								`MalArrayObject *${reg.name} = mal_vm_as_array(${boxed(instruction.object)});`,
							]
						: []),
					`if (!(${reg.name} && mal_vm_array_try_store(${reg.name}, ${num(instruction.key)}, ${boxed(instruction.value)}))) {`,
					`  mal_vm_array_fast_store_index(vm, ${boxed(instruction.object)}, ${num(instruction.key)}, ${boxed(instruction.value)}, ${strict}, &__property_ic[${instruction.icIndex}]);`,
					`  ${throwCheck}`,
					`}`,
				];
				if (instruction.nativeAffineRangeVirtualization?.role === "store") {
					const allocationIp = instruction.nativeAffineRangeVirtualization.allocationIp;
					return [
						`if (__affine_range_${allocationIp}) {`,
						`  MAL_PERF_COUNT(array_affine_range_stores_elided);`,
						`} else {`,
						...ordinary.map((line) => `  ${line}`),
						`}`,
					];
				}
				return ordinary;
			}
			if (!reg.consolidated) {
				const probe =
					instruction.opcode === "STORE_PROPERTY_STATIC"
						? `${reg.name} && mal_vm_object_try_store_static(${reg.name}, ${boxed(instruction.value)}, &__property_ic[${instruction.icIndex}])`
						: `${reg.name} && mal_vm_object_try_store(${reg.name}, ${key}, ${boxed(instruction.value)}, &__property_ic[${instruction.icIndex}])`;
				return [
					...(reg.declare
						? [`MalObject *${reg.name} = mal_vm_as_object(${boxed(instruction.object)});`]
						: []),
					`if (!(${probe})) {`,
					`  mal_vm_op_store_property_ic(vm, ${boxed(instruction.object)}, ${key}, ${boxed(instruction.value)}, ${strict}, &__property_ic[${instruction.icIndex}]);`,
					`  ${throwCheck}`,
					`}`,
				];
			}
			// Consolidated object region (see LOAD_PROPERTY): a hit is a barriered cached-slot
			// overwrite (the shape guard proved the slot writable-default), a miss the IC.
			const regionHit =
				instruction.opcode === "STORE_PROPERTY_STATIC"
					? `${reg.name}_ok`
					: `${reg.name}_ok && ${key} == ${reg.name}_c->keys[${reg.slotIndex}]`;
			const icProbe =
				instruction.opcode === "STORE_PROPERTY_STATIC"
					? `${reg.name}_o && mal_vm_object_try_store_static(${reg.name}_o, ${boxed(instruction.value)}, &__property_ic[${instruction.icIndex}])`
					: `${reg.name}_o && mal_vm_object_try_store(${reg.name}_o, ${key}, ${boxed(instruction.value)}, &__property_ic[${instruction.icIndex}])`;
			return [
				...(reg.declare ? consolidatedRegionDeclare(reg, boxed(instruction.object)) : []),
				...consolidatedRegionRevalidate(reg),
				`if (${regionHit}) {`,
				`  mal_perf_ic_store_region_hit();`,
				`  mal_vm_object_slot_store(${reg.name}_o, ${reg.name}_slp[${reg.slotIndex}], ${boxed(instruction.value)});`,
				`} else if (!(${icProbe})) {`,
				`  mal_vm_op_store_property_ic(vm, ${boxed(instruction.object)}, ${key}, ${boxed(instruction.value)}, ${strict}, &__property_ic[${instruction.icIndex}]);`,
				`  ${throwCheck}`,
				`}`,
				...(reg.commit ? consolidatedRegionCommit(reg) : []),
			];
		}
		case "TO_PROPERTY_KEY":
			return [
				`r${instruction.dst} = mal_vm_op_to_property_key(vm, ${boxed(instruction.object)}, ${boxed(instruction.key)});`,
				throwCheck,
			];
		case "LOAD_GLOBAL":
			return [`r${instruction.dst} = vm->globals[${instruction.index}];`];
		case "STORE_GLOBAL":
			return [`vm->globals[${instruction.index}] = ${boxed(instruction.src)};`];
		case "STORE_GLOBAL_PROPERTY":
			// A var/function declaration that becomes a property of globalThis.
			return [
				`mal_vm_op_store_global_property(vm, ${instruction.nameStringIndex}, ${boxed(instruction.src)}, ${strict}, ${instruction.declaration}, ${instruction.declarationConfigurable});`,
				throwCheck,
			];
		case "INIT_GLOBAL_VARS":
			return [
				`mal_vm_op_init_global_vars(vm, ${instruction.nameStringIndices.length}, (const i32[]){ ${instruction.nameStringIndices.join(", ")} }, ${instruction.declarationConfigurable});`,
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
			const leftIsNum = reps[left] === "number";
			const rightIsNum = reps[right] === "number";
			const dstIsBool = reps[dst] === "boolean";
			const compare = NATIVE_COMPARE[operator];
			const fusion = instruction.nativeNumericFusion;
			const finiteString = instruction.nativeFiniteString;
			if (
				operator === "+" &&
				finiteString !== undefined &&
				finiteString.stringIndices.length > 0
			) {
				const table = `__finite_string_${ip}`;
				const finiteNumber = rightIsNum
					? num(right)
					: `mal_ops_number_as_f64(${boxed(right)})`;
				const offset =
					finiteString.minimum === 0
						? `(i32) ${finiteNumber}`
						: `(i32) ${finiteNumber} - (${finiteString.minimum})`;
				return [
					`static const i32 ${table}[] = { ${finiteString.stringIndices.join(", ")} };`,
					`r${dst} = mal_value_from_string(&mal_strings${suffix}[${table}[${offset}]]);`,
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
				const firstExpr = nativeNumberExpr(
					first.operator,
					reps[first.left] === "number"
						? num(first.left)
						: `mal_ops_number_as_f64(${boxed(first.left)})`,
					reps[first.right] === "number"
						? num(first.right)
						: `mal_ops_number_as_f64(${boxed(first.right)})`,
				);
				if ((firstOnLeft || firstOnRight) && firstExpr !== null) {
					const external = firstOnLeft ? right : left;
					const externalExpr =
						reps[external] === "number"
							? num(external)
							: `mal_ops_number_as_f64(${boxed(external)})`;
					const compare = NATIVE_COMPARE[operator];
					if (compare !== undefined) {
						const guard =
							reps[external] === "number"
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
						const guard =
							reps[external] === "number"
								? `__nf_${fusion.id}_ok`
								: `__nf_${fusion.id}_ok && mal_ops_is_number(${boxed(external)})`;
						const slow = `mal_vm_binary_op(vm, ${emitBinaryOperator(operator)}, ${boxed(left)}, ${boxed(right)})`;
						return [
							`if (${guard}) {`,
							`  r${dst} = mal_ops_number_value(${nativeExpr});`,
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
			// numbers (see producedRep / producesNumberFromNumbers) — emit native
			// arithmetic or a native ToInt32-based bitwise/shift/remainder, all
			// holding their integer-valued results as a double.
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
				reps[r] === "number" ? `r${r}` : `mal_ops_number_as_f64(${boxed(r)})`;
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
				reps[src] === "number"
					? "number"
					: reps[src] === "boolean"
						? "boolean"
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
			if (reps[dst] === "number") {
				if (reps[src] !== "number") {
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
					`r${instruction.dst} = mal_builtin_array_push_known(vm, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${instruction.arguments.length});`,
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
			if (invariantJsonMapAction?.role === "parse") {
				const site = invariantJsonMapAction.site;
				const cache = `__invariant_json_map_${site.parseCallIp}`;
				const hit = `${cache}_hit`;
				const text = boxed(site.text);
				const captures = `((MalJsonProjectionCapture[]){ ${site.captures.map((capture) => `{ .owner_function_index = ${capture.ownerFunctionIndex}, .index = ${capture.index} }`).join(", ")} })`;
				return [
					`static MalCallCache __cc_${ip};`,
					`${hit} = mal_builtin_json_map_template_try_clone(vm, &${cache}, ${boxed(site.parseCallee)}, ${boxed(site.jsonObject)}, ${text}, ${boxed(site.callback)}, ${site.targetFunctionIndex}, ${captures}, ${site.captures.length}, &r${site.mapResult});`,
					`if (${hit}) {`,
					`  r${site.parseResult} = MAL_VALUE_UNDEFINED;`,
					`} else {`,
					`  ${throwCheck}`,
					`  if (${cache}.state == MAL_INVARIANT_JSON_MAP_EMPTY) { ${cache}.roots[1] = ${text}; ${cache}.roots[2] = ${boxed(site.callback)}; ${cache}.roots[3] = ${boxed(site.parseCallee)}; }`,
					`  MalCompletion ${tmp} = mal_vm_call_cached(vm, &__cc_${ip}, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length});`,
					`  if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow}`,
					`  r${instruction.dst} = ${tmp}.value;`,
					`}`,
					poll,
				];
			}
			if (invariantJsonMapAction?.role === "mapCall") {
				const site = invariantJsonMapAction.site;
				const cache = `__invariant_json_map_${site.parseCallIp}`;
				const hit = `${cache}_hit`;
				const captures = `((MalJsonProjectionCapture[]){ ${site.captures.map((capture) => `{ .owner_function_index = ${capture.ownerFunctionIndex}, .index = ${capture.index} }`).join(", ")} })`;
				const values = (indices: ReadonlyArray<number>) =>
					`((MalValue[]){ ${indices.map((index) => `mal_value_from_string(vm->string_constant_atoms[${index}])`).join(", ")} })`;
				return [
					`if (!${hit}) {`,
					`  static MalCallCache __cc_${ip};`,
					`  MalCompletion ${tmp} = mal_vm_call_cached(vm, &__cc_${ip}, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length});`,
					`  if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow}`,
					`  r${instruction.dst} = ${tmp}.value;`,
					`  ${poll}`,
					`  (void) mal_builtin_json_map_template_fill(vm, &${cache}, ${cache}.roots[3], vm->intrinsics[MAL_INTRINSIC_JSON], ${cache}.roots[1], ${boxed(site.mapCallee)}, ${boxed(site.parseResult)}, ${cache}.roots[2], ${site.targetFunctionIndex}, ${captures}, ${site.captures.length}, r${site.mapResult}, ${values(site.primitiveRowStringIndices)}, ${site.primitiveRowStringIndices.length}, mal_value_from_string(vm->string_constant_atoms[${site.nestedBaseStringIndex}]), mal_value_from_string(vm->string_constant_atoms[${site.nestedValueStringIndex}]), ${values(site.excludedStringIndices)}, ${site.excludedStringIndices.length}, ${site.rowPropertyLoads});`,
					`  ${throwCheck}`,
					`} else {`,
					`  ${poll}`,
					`}`,
				];
			}
			if (privateAggregateMemo !== undefined) {
				const memo = `__private_aggregate_memo_${ip}`;
				const callee = `__private_aggregate_callee_${ip}`;
				const input = boxedOperand(instruction.arguments[0]!);
				return [
					`MalValue ${callee} = ${boxedOperand(instruction.callee)};`,
					`if (!mal_builtin_array_private_aggregate_memo_probe(vm, &${memo}, ${callee}, ${boxedOperand(instruction.thisValue)}, ${input}, ${privateAggregateMemo.targetFunctionIndex}, &r${instruction.dst})) {`,
					`  if (mal_vm_callee_has_index(vm, ${callee}, ${privateAggregateMemo.targetFunctionIndex})) {`,
					`    if (!mal_vm_enter_compiled(vm, ${privateAggregateMemo.targetFunctionIndex})) ${onThrow}`,
					`    const MalFunction *__private_aggregate_function_${ip} = &vm->definition->functions[${privateAggregateMemo.targetFunctionIndex}];`,
					`    MalValue __private_aggregate_value_${ip} = mal_compiled_${privateAggregateMemo.targetFunctionIndex}${suffix}(vm, mal_vm_callee_this(vm, __private_aggregate_function_${ip}, ${boxedOperand(instruction.thisValue)}), ${argsExpr}, ${args.length}, MAL_VALUE_UNDEFINED, mal_value_to_function_object(${callee})->creation_env, ${callee}, nullptr);`,
					`    mal_vm_leave_compiled(vm);`,
					`    if (vm->completion.kind == MAL_COMPLETION_THROW) ${onThrow}`,
					`    r${instruction.dst} = __private_aggregate_value_${ip};`,
					`  } else {`,
					`    static MalCallCache __cc_${ip};`,
					`    MalCompletion ${tmp} = mal_vm_call_direct(vm, &__cc_${ip}, ${privateAggregateMemo.targetFunctionIndex}, ${callee}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length});`,
					`    if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow}`,
					`    r${instruction.dst} = ${tmp}.value;`,
					`  }`,
					`  ${poll}`,
					`  mal_builtin_array_private_aggregate_memo_fill(vm, &${memo}, ${callee}, ${boxedOperand(instruction.thisValue)}, ${input}, ${privateAggregateMemo.targetFunctionIndex}, r${instruction.dst});`,
					`} else {`,
					`  ${poll}`,
					`}`,
				];
			}
			if (invariantJsonParseCache !== undefined) {
				const cache = `__invariant_json_parse_${ip}`;
				const text = boxedOperand(instruction.arguments[0]!);
				return [
					`static MalCallCache __cc_${ip};`,
					`if (mal_builtin_json_parse_cache_try_clone(vm, &${cache}, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${text}, &r${instruction.dst})) {`,
					`  ${throwCheck}`,
					`} else {`,
					`  ${throwCheck}`,
					`  MalCompletion ${tmp} = mal_vm_call_cached(vm, &__cc_${ip}, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length});`,
					`  if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow}`,
					`  r${instruction.dst} = ${tmp}.value;`,
					`  (void) mal_builtin_json_parse_cache_fill(vm, &${cache}, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${text}, r${instruction.dst});`,
					`  ${throwCheck}`,
					`}`,
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
								`  r${propertyLoad.dst} = mal_vm_op_load_property_ic(vm, ${boxedOperand(propertyLoad.object)}, mal_value_from_string(vm->string_constant_atoms[${propertyLoad.stringIndex}]), &__property_ic[${propertyLoad.icIndex}]);`,
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
			if (
				instruction.directStringSearchRegExp === true &&
				instruction.directStringSearchLiteralConstructIp !== undefined
			) {
				const fast = `__string_search_literal_${ip}_fast`;
				const direct = `__string_search_literal_${ip}_result`;
				const regexpDirect = `__string_search_${ip}_result`;
				return [
					`static MalCallCache __cc_${ip};`,
					`if (${fast}) {`,
					`  r${instruction.dst} = ${direct};`,
					`} else {`,
					`  MalValue ${regexpDirect};`,
					`  if (mal_builtin_string_search_regexp_direct(vm, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${boxedOperand(instruction.arguments[0]!)}, &${regexpDirect})) {`,
					`    ${throwCheck}`,
					`    r${instruction.dst} = ${regexpDirect};`,
					`  } else {`,
					`    MalCompletion ${tmp} = mal_vm_call_cached(vm, &__cc_${ip}, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length});`,
					`    if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow}`,
					`    r${instruction.dst} = ${tmp}.value;`,
					`  }`,
					`}`,
					poll,
				];
			}
			if (instruction.directStringSearchRegExp === true) {
				const direct = `__string_search_${ip}_result`;
				return [
					`static MalCallCache __cc_${ip};`,
					`MalValue ${direct};`,
					`if (mal_builtin_string_search_regexp_direct(vm, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${boxedOperand(instruction.arguments[0]!)}, &${direct})) {`,
					`  ${throwCheck}`,
					`  r${instruction.dst} = ${direct};`,
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
									`  r${propertyLoad.dst} = mal_vm_op_load_property_ic(vm, ${boxedOperand(propertyLoad.object)}, mal_value_from_string(vm->string_constant_atoms[${propertyLoad.stringIndex}]), &__property_ic[${propertyLoad.icIndex}]);`,
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
								`  r${propertyLoad.dst} = mal_vm_op_load_property_ic(vm, ${boxedOperand(propertyLoad.object)}, mal_value_from_string(vm->string_constant_atoms[${propertyLoad.stringIndex}]), &__property_ic[${propertyLoad.icIndex}]);`,
								`  ${throwCheck}`,
							]),
					`  MalCompletion ${tmp} = mal_vm_call_cached(vm, &__cc_${ip}, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length});`,
					`  if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow}`,
					`  r${instruction.dst} = ${tmp}.value;`,
					`  ${poll}`,
					`}`,
				];
			}
			if (stringCharCodeAtFusion !== undefined && stringCharCodeAtFusion.callIp === ip) {
				const fusion = stringCharCodeAtFusion;
				const receiver = boxedOperand(instruction.thisValue);
				const firstNumber = args.length === 0 ? "0.0" : nativeNumberOperand(args[0]!);
				const numberGuard =
					firstNumber !== null ? "true" : `mal_ops_is_number(${boxedOperand(args[0]!)})`;
				const position =
					firstNumber ?? `mal_ops_number_as_f64(${boxedOperand(args[0]!)})`;
				const boundedPosition =
					instruction.directStringCharCodeAtPosition === "inBounds" &&
					firstNumber !== null
						? `(usize) (${firstNumber})`
						: null;
				const callee = `r${fusion.load.dst}`;
				const lockedIdentity =
					instruction.guardedBuiltinCall !== undefined &&
					vmGuardIsWorldInvariant(instruction.guardedBuiltinCall.guard);
				const identityGuard = lockedIdentity
					? ""
					: `mal_vm_local_watched_primitive_value_try_load_static(vm, __watched_methods_epoch, MAL_PRIM_KIND_STRING, &__property_ic[${fusion.load.icIndex}], &${callee}) && `;
				return [
					`static MalCallCache __cc_${ip};`,
					`if (${identityGuard}mal_value_is_string(${receiver}) && ${numberGuard}) {`,
					boundedPosition === null
						? `  r${instruction.dst} = mal_builtin_string_char_code_at_number(${receiver}, ${position});`
						: `  r${instruction.dst} = mal_builtin_string_char_code_at_in_bounds(${receiver}, ${boundedPosition});`,
					`} else {`,
					`  ${callee} = mal_vm_op_load_property_ic(vm, ${boxedOperand(fusion.load.object)}, mal_value_from_string(vm->string_constant_atoms[${fusion.load.stringIndex}]), &__property_ic[${fusion.load.icIndex}]);`,
					`  ${throwCheck}`,
					`  MalCompletion ${tmp} = mal_builtin_string_char_code_at_direct(vm, &__cc_${ip}, ${callee}, ${receiver}, ${argsExpr}, ${args.length});`,
					`  if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow}`,
					`  r${instruction.dst} = ${tmp}.value;`,
					`  ${poll}`,
					`}`,
				];
			}
			if (cardinalityPush !== undefined) {
				const target = cardinalityPush;
				const fastResult =
					reps[instruction.dst] === "number"
						? `(f64) ${target.countName}`
						: `mal_value_from_i32((i32) ${target.countName})`;
				const current = `__cardinality_${ip}_current`;
				return [
					`if (${target.fastName} && ${target.countName} < ${target.maximumLength}${cardinalityEpochGuard(target)}) {`,
					...Array.from(
						{ length: target.itemSite.slotCount },
						(_, slot) =>
							`  __gc_slots[${target.historySlotsOffset} + ${target.countName} * ${target.itemSite.slotCount} + ${slot}] = __gc_slots[${target.itemSite.slotsOffset + slot}];`,
					),
					`  ${target.countName}++;`,
					`  r${instruction.dst} = ${fastResult};`,
					`} else {`,
					`  if (${target.fastName}) {`,
					...materializeCardinalityRegion(target).map((line) => `    ${line}`),
					`  }`,
					`  MalValue ${current} = mal_vm_materialize_stack_object(vm, &${target.itemSite.objectName});`,
					`  ${throwCheck}`,
					`  r${target.itemRegister} = ${current};`,
					`  ${target.currentMaterializedName} = true;`,
					`  static MalCallCache __cc_${ip};`,
					`  MalCompletion ${tmp} = mal_builtin_array_push_direct(vm, &__cc_${ip}, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, &${current}, 1, nullptr);`,
					`  if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow}`,
					`  r${instruction.dst} = ${tmp}.value;`,
					`  ${poll}`,
					`}`,
				];
			}
			const guardedBuiltinOperation = instruction.guardedBuiltinCall?.operation;
			if (
				guardedBuiltinOperation === "Map.prototype.get" ||
				guardedBuiltinOperation === "Map.prototype.set" ||
				guardedBuiltinOperation === "Set.prototype.add"
			) {
				const operation = {
					"Map.prototype.get": "MAL_BUILTIN_COLLECTION_MAP_GET",
					"Map.prototype.set": "MAL_BUILTIN_COLLECTION_MAP_SET",
					"Set.prototype.add": "MAL_BUILTIN_COLLECTION_SET_ADD",
				}[guardedBuiltinOperation];
				return [
					`static MalCallCache __cc_${ip};`,
					`MalCompletion ${tmp} = mal_builtin_collection_direct(vm, &__cc_${ip}, ${operation}, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length});`,
					`if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow}`,
					`r${instruction.dst} = ${tmp}.value;`,
					poll,
				];
			}
			if (vmCallProvesBuiltin(instruction, "Array.prototype.push")) {
				const exact = `__private_aggregate_push_exact_${ip}`;
				const memo = privateAggregatePushMemo;
				return [
					`static MalCallCache __cc_${ip};`,
					...(memo === undefined ? [] : [`bool ${exact} = false;`]),
					`MalCompletion ${tmp} = mal_builtin_array_push_direct(vm, &__cc_${ip}, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length}, ${memo === undefined ? "nullptr" : `&${exact}`});`,
					`if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow}`,
					`r${instruction.dst} = ${tmp}.value;`,
					...(memo === undefined
						? []
						: [
								`mal_builtin_array_private_aggregate_memo_note_push(vm, &__private_aggregate_memo_${memo.callIp}, ${exact});`,
							]),
					poll,
				];
			}
			if (vmCallProvesBuiltin(instruction, "String.prototype.charCodeAt")) {
				return [
					`static MalCallCache __cc_${ip};`,
					`MalCompletion ${tmp} = mal_builtin_string_char_code_at_direct(vm, &__cc_${ip}, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length});`,
					`if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow}`,
					`r${instruction.dst} = ${tmp}.value;`,
					poll,
				];
			}
			if (instruction.directFunctionCall) {
				return [
					`static MalCallCache __cc_${ip};`,
					`MalCompletion ${tmp} = mal_vm_call_function_call_direct(vm, &__cc_${ip}, ${instruction.directCallTargetFunctionIndex ?? -1}, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length});`,
					`if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow}`,
					`r${instruction.dst} = ${tmp}.value;`,
					poll,
				];
			}
			if (instruction.directFunctionIndex !== undefined) {
				const target = instruction.directFunctionIndex;
				if (directCompiledTargets.has(target)) {
					const directCallee = `__direct_callee_${ip}`;
					const directFunction = `__direct_function_${ip}`;
					const directValue = `__direct_value_${ip}`;
					const nativeArgumentCount = directCompiledTargets.get(target) ?? 0;
					const nativeArguments = instruction.arguments
						.slice(0, nativeArgumentCount)
						.map(nativeNumberOperand);
					const useNativeArguments =
						nativeArgumentCount > 0 &&
						instruction.arguments.length >= nativeArgumentCount &&
						nativeArguments.every((argument) => argument !== null);
					const nativeArgumentExpressions = Array.from({ length: 4 }, (_, i) =>
						i < nativeArgumentCount ? nativeArguments[i]! : "0.0",
					).join(", ");
					return [
						`MalValue ${directCallee} = ${boxedOperand(instruction.callee)};`,
						`if (mal_vm_callee_has_index(vm, ${directCallee}, ${target})) {`,
						`  if (!mal_vm_enter_compiled(vm, ${target})) ${onThrow}`,
						`  const MalFunction *${directFunction} = &vm->definition->functions[${target}];`,
						`  MalValue ${directValue} = ${useNativeArguments ? `mal_compiled_${target}${suffix}_native_numbers` : `mal_compiled_${target}${suffix}`}(vm, mal_vm_callee_this(vm, ${directFunction}, ${boxedOperand(instruction.thisValue)}), ${useNativeArguments ? "nullptr" : argsExpr}, ${args.length}, MAL_VALUE_UNDEFINED, mal_value_to_function_object(${directCallee})->creation_env, ${directCallee}, ${useNativeArguments ? `(void *) vm, ${nativeArgumentExpressions}` : "nullptr"});`,
						`  mal_vm_leave_compiled(vm);`,
						`  if (vm->completion.kind == MAL_COMPLETION_THROW) ${onThrow}`,
						`  r${instruction.dst} = ${directValue};`,
						`} else {`,
						`  static MalCallCache __cc_${ip};`,
						`  MalCompletion ${tmp} = mal_vm_call_direct(vm, &__cc_${ip}, ${target}, ${directCallee}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length});`,
						`  if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow}`,
						`  r${instruction.dst} = ${tmp}.value;`,
						`}`,
						poll,
					];
				}
				return [
					`static MalCallCache __cc_${ip};`,
					`MalCompletion ${tmp} = mal_vm_call_direct(vm, &__cc_${ip}, ${instruction.directFunctionIndex}, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length});`,
					`if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow}`,
					`r${instruction.dst} = ${tmp}.value;`,
					poll,
				];
			}
			if (mathUnaryCall) {
				const argument = instruction.arguments[0]!;
				const nativeOperation = MATH_UNARY_NATIVE_OP.get(
					instruction.guardedBuiltinCall?.operation ?? "",
				);
				const nativeArgument = nativeNumberOperand(argument);
				if (
					reps[instruction.dst] === "number" &&
					nativeOperation !== undefined &&
					nativeArgument !== null
				) {
					return [
						`r${instruction.dst} = mal_builtin_math_unary_number_known(${nativeOperation}, ${nativeArgument});`,
						poll,
					];
				}
				return [
					`static MalMathUnaryOp __math_${ip};`,
					`MalValue __math_result_${ip};`,
					`if (mal_builtin_math_unary_fast(${boxedOperand(instruction.callee)}, &__math_${ip}, ${boxedOperand(argument)}, &__math_result_${ip})) {`,
					`  r${instruction.dst} = __math_result_${ip};`,
					`} else {`,
					`  static MalCallCache __cc_${ip};`,
					`  MalCompletion ${tmp} = mal_vm_call_cached(vm, &__cc_${ip}, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length});`,
					`  if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow}`,
					`  r${instruction.dst} = ${tmp}.value;`,
					`}`,
					poll,
				];
			}
			if (mathBinaryCall) {
				const left = instruction.arguments[0]!;
				const right = instruction.arguments[1]!;
				const nativeOperation = MATH_BINARY_NATIVE_OP.get(
					instruction.guardedBuiltinCall?.operation ?? "",
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
						poll,
					];
				}
				return [
					`static MalMathBinaryOp __math_${ip};`,
					`MalValue __math_result_${ip};`,
					`if (mal_builtin_math_binary_fast(${boxedOperand(instruction.callee)}, &__math_${ip}, ${boxedOperand(left)}, ${boxedOperand(right)}, &__math_result_${ip})) {`,
					`  r${instruction.dst} = __math_result_${ip};`,
					`} else {`,
					`  static MalCallCache __cc_${ip};`,
					`  MalCompletion ${tmp} = mal_vm_call_cached(vm, &__cc_${ip}, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length});`,
					`  if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow}`,
					`  r${instruction.dst} = ${tmp}.value;`,
					`}`,
					poll,
				];
			}
			// A per-site polymorphic call cache: exact native callees and ordinary compiled
			// closures sharing a function index skip the dispatch chain. Bound, proxy, and
			// interpreted callees stay on the slow path.
			return [
				`static MalCallCache __cc_${ip};`,
				`MalCompletion ${tmp} = mal_vm_call_cached(vm, &__cc_${ip}, ${boxedOperand(instruction.callee)}, ${boxedOperand(instruction.thisValue)}, ${argsExpr}, ${args.length});`,
				`if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow}`,
				`r${instruction.dst} = ${tmp}.value;`,
				poll, // call-return safepoint
			];
		}
		case "CONSTRUCT": {
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
				instruction.directFunctionIndex === undefined
					? `mal_vm_construct_value(vm, ${boxedOperand(instruction.callee)}, ${argsExpr}, ${args.length})`
					: `mal_vm_construct_direct(vm, ${instruction.directFunctionIndex}, ${boxedOperand(instruction.callee)}, ${argsExpr}, ${args.length})`;
			if (instruction.directStringSearchLiteral !== undefined) {
				const site = instruction.directStringSearchLiteral;
				const fast = `__string_search_literal_${site.callIp}_fast`;
				const direct = `__string_search_literal_${site.callIp}_result`;
				return [
					`${fast} = mal_builtin_string_search_literal_direct(vm, ${boxedOperand(site.searchCallee)}, ${boxedOperand(site.receiver)}, &mal_strings${suffix}[${site.patternStringIndex}], &${direct});`,
					`if (${fast}) {`,
					`  r${instruction.dst} = MAL_VALUE_UNDEFINED;`,
					`} else {`,
					`  MalCompletion ${tmp} = ${construct};`,
					`  if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow}`,
					`  r${instruction.dst} = ${tmp}.value;`,
					`}`,
					poll,
				];
			}
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
			return [`mal_vm_op_load_undeclared(vm, ${instruction.nameStringIndex});`, onThrow];
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
			return [
				`MalIteratorRecord ${rec};`,
				`if (!mal_vm_get_iterator(vm, ${boxed(instruction.source)}, &${rec})) ${onThrow}`,
				`r${instruction.iteratorDst} = ${rec}.iterator;`,
				`r${instruction.nextDst} = ${rec}.next_method;`,
				...(denseIteratorCursor?.kind === "capture"
					? [
							`${denseIteratorCursor.cursor.name} = mal_vm_iterator_dense_array_cursor(&${rec});`,
						]
					: []),
			];
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
			const step =
				denseIteratorCursor?.kind === "step"
					? `${denseIteratorCursor.cursor.name} != nullptr ? mal_vm_iterator_step_dense_array_cursor(vm, ${denseIteratorCursor.cursor.name}, &${rec}, &${val}, &${done}) : mal_vm_iterator_step_fast(vm, &${rec}, &${val}, &${done})`
					: `mal_vm_iterator_step_fast(vm, &${rec}, &${val}, &${done})`;
			if (nativeRegExpIteratorProjectionAction?.role === "step") {
				const site = nativeRegExpIteratorProjectionAction.site;
				const indices = site.loads.map((load) => load.captureIndex).join(", ");
				const outputs = site.loads
					.map((_load, index) => `&__gc_slots[${site.slotsOffset + index}]`)
					.join(", ");
				const status = `regexp_iter_status_${ip}`;
				return [
					`MalIteratorRecord ${rec} = { .iterator = ${boxed(instruction.iterator)}, .next_method = ${boxed(instruction.next)} };`,
					`MalValue ${val}; bool ${done};`,
					`__regexp_iter_${site.projection.stepIp}_projected = false;`,
					`int ${status} = mal_regexp_try_exact_iterator_capture_projection(vm, ${boxed(instruction.iterator)}, ${boxed(instruction.next)}, (const u32[]){ ${indices} }, (MalValue *[]){ ${outputs} }, ${site.loads.length}, __regexp_iter_${site.projection.stepIp}_starts, __regexp_iter_${site.projection.stepIp}_ends, &__gc_slots[${site.subjectSlot}], &${val}, &${done});`,
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
			if (
				loopTwinEmission !== undefined &&
				ip === loopTwinEmission.twin.backedgeIp &&
				instruction.targetIp === loopTwinEmission.twin.headerIp
			) {
				if (loopTwinEmission.kind === "generic") {
					return [poll, `goto LG${instruction.targetIp};`];
				}
				return [
					`if (mal_gc_poll) {`,
					...materializeDeferredInheritedValue(loopTwinEmission.twin).map(
						(line) => `  ${line}`,
					),
					...(loopTwinEmission.publishPosition && loopTwinEmission.twin.position !== -1
						? [
								`  vm->native_frames[vm->native_frame_count - 1].pos_id = ${loopTwinEmission.twin.position};`,
							]
						: []),
					`  mal_gc_safepoint(vm);`,
					`  if (!${loopTwinValidation(loopTwinEmission.twin)}) goto LG${instruction.targetIp};`,
					`}`,
					`goto LF${instruction.targetIp};`,
				];
			}
			if (
				loopTwinEmission?.kind === "fast" &&
				instruction.targetIp >= loopTwinEmission.twin.headerIp &&
				instruction.targetIp <= loopTwinEmission.twin.backedgeIp
			) {
				return [`goto LF${instruction.targetIp};`];
			}
			if (loopTwinEmission?.kind === "fast") {
				return [
					...materializeDeferredInheritedValue(loopTwinEmission.twin),
					`goto L${instruction.targetIp};`,
				];
			}
			return instruction.targetIp <= ip
				? [poll, `goto L${instruction.targetIp};`]
				: [`goto L${instruction.targetIp};`];
		case "JUMP_IF":
			// Branch on a raw bool / native truthiness test — no boxing when the
			// condition is already a boolean-rep (typically a comparison result).
			// Poll on a taken back-edge only.
			if (
				loopTwinEmission?.kind === "fast" &&
				instruction.targetIp >= loopTwinEmission.twin.headerIp &&
				instruction.targetIp <= loopTwinEmission.twin.backedgeIp
			) {
				return [`if (${truthy(instruction.cond)}) goto LF${instruction.targetIp};`];
			}
			if (loopTwinEmission?.kind === "fast") {
				return [
					`if (${truthy(instruction.cond)}) {`,
					...materializeDeferredInheritedValue(loopTwinEmission.twin).map(
						(line) => `  ${line}`,
					),
					`  goto L${instruction.targetIp};`,
					`}`,
				];
			}
			return instruction.targetIp <= ip
				? [`if (${truthy(instruction.cond)}) { ${poll} goto L${instruction.targetIp}; }`]
				: [`if (${truthy(instruction.cond)}) goto L${instruction.targetIp};`];
		case "RETURN": {
			// Register -1 is the "no value" sentinel (a synthesized empty return).
			let value =
				instruction.value < 0 ? "MAL_VALUE_UNDEFINED" : boxed(instruction.value);
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
				`r${instruction.dst} = mal_vm_op_load_global_property(vm, ${instruction.nameStringIndex});`,
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
					? `(const i32[]){ ${instruction.cookedIndices.join(", ")} }`
					: "nullptr";
			const raw =
				count > 0 ? `(const i32[]){ ${instruction.rawIndices.join(", ")} }` : "nullptr";
			return [
				`r${instruction.dst} = mal_vm_op_create_template_object(vm, ${instruction.cacheSlot}, ${count}, ${cooked}, ${raw});`,
			];
		}
		case "CREATE_MODULE_NAMESPACE": {
			const count = instruction.nameIndices.length;
			const names =
				count > 0 ? `(const i32[]){ ${instruction.nameIndices.join(", ")} }` : "nullptr";
			const slots =
				count > 0 ? `(const i32[]){ ${instruction.slots.join(", ")} }` : "nullptr";
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
				`mal_vm_op_create_private_names(vm, env, ${instruction.ownerFunctionIndex}, ${instruction.capturedIndices.length}, (const i32[]){ ${instruction.capturedIndices.join(", ")} });`,
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
				`r${instruction.dst} = mal_vm_op_has_private(vm, ${boxed(instruction.object)}, ${boxed(instruction.key)});`,
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
				`r${instruction.dst} = mal_vm_op_with_get(vm, env, ${instruction.nameStringIndex});`,
				throwCheck,
			];
		case "WITH_RESOLVE_BASE":
			// The reference base (the with-object itself) for a read/write through it.
			return [
				`r${instruction.dst} = mal_vm_op_with_resolve_base(vm, env, ${instruction.nameStringIndex});`,
				throwCheck,
			];
		case "WITH_SET":
			// Assign through the with-envs; `found` (always boxed-rep) reports whether a
			// binding matched so the IR can fall back to the static binding on a miss.
			return [
				`r${instruction.found} = mal_value_new_boolean(mal_vm_op_with_set(vm, env, ${instruction.nameStringIndex}, ${boxed(instruction.value)}));`,
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
