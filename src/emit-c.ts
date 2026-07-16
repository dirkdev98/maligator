import { emitBinaryOperator, emitIntrinsic, emitUnaryOperator } from "./emit-vm.ts";
import type { VmExceptionHandler, VmFunction, VmInstruction } from "./lower-vm.ts";

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

export interface CompiledFunction {
	/** The C symbol to install as MalFunction.compiled. */
	symbol: string;
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

/** Unary `+` on a BigInt throws, so it needs a completion check after. */
const THROWING_UNARY_OPERATORS = new Set(["+"]);

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
		const right32 =
			operator === "<<" || operator === ">>"
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
 * type query like `!`/typeof, or `in`/`instanceof`).
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

	// Per-register direct-use classification, plus the forward value-copy graph.
	// The register allocator pins parameters and routinely copies them into a
	// working register before any arithmetic (`r1 = r0; ... r1 < n`), so a
	// parameter's evidence has to be followed across MOVEs: `numericUse` /
	// `disqualUse` record the *register* a use applies to, and a parameter
	// inherits the uses of every register its value reaches via MOVE.
	const numericUse = new Set<number>();
	const disqualUse = new Set<number>();
	const moveTargets = new Map<number, Array<number>>();
	const addEdge = (src: number, dst: number): void => {
		const list = moveTargets.get(src);
		if (list === undefined) {
			moveTargets.set(src, [dst]);
		} else {
			list.push(dst);
		}
	};

	for (const instruction of fn.instructions) {
		switch (instruction.opcode) {
			case "MOVE":
				addEdge(instruction.src, instruction.dst);
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
			case "CREATE_ARRAY":
			case "INSTANTIATE_LITERAL_TEMPLATE":
			case "CREATE_FUNCTION":
			case "CREATE_ARGUMENTS_OBJECT": // reads the raw args, no register operand
			case "LOAD_ARGUMENT_COUNT": // reads arg_count, no register operand
			case "LOAD_ARGUMENT": // reads the raw args, no register operand
			case "CREATE_REST_ARGUMENTS": // reads the raw args, no register operand
			case "DEFINE_PROPERTY": // object is the literal; key/value boxed boundary reads
			case "LOAD_THIS":
			case "LOAD_NEW_TARGET":
			case "LOAD_UNDECLARED":
			case "LOAD_CAPTURED":
			case "LOAD_GLOBAL":
			case "LOAD_INTRINSIC":
			case "STORE_GLOBAL": // src boxed at the global-store boundary
			case "STORE_CAPTURED": // src boxed into the captured slot
			case "THROW": // value boxed at the throw boundary
			case "JUMP":
			case "JUMP_IF": // cond read via native truthiness — fine for a number
			case "RETURN": // value boxed at return
				break;
			case "CONSTRUCT":
				disqualUse.add(instruction.callee);
				// arguments are neutral boundary reads
				break;
			case "LOAD_PROPERTY":
			case "LOAD_SUPER_PROPERTY":
				disqualUse.add(instruction.object);
				disqualUse.add(instruction.key);
				if (instruction.opcode === "LOAD_SUPER_PROPERTY") {
					disqualUse.add(instruction.receiver);
				}
				break;
			case "STORE_PROPERTY":
				disqualUse.add(instruction.object);
				disqualUse.add(instruction.key);
				// value is a neutral boundary read
				break;
			case "TO_PROPERTY_KEY":
				// object and key are read as boxed values, never numerically.
				disqualUse.add(instruction.object);
				disqualUse.add(instruction.key);
				break;
			case "FOR_IN_KEYS":
				// source is enumerated as an object, never read numerically.
				disqualUse.add(instruction.source);
				break;
			case "ARRAY_REST":
				// src is read as an array-like, never numerically.
				disqualUse.add(instruction.src);
				break;
			case "CALL":
				disqualUse.add(instruction.callee);
				disqualUse.add(instruction.thisValue);
				// arguments are neutral boundary reads
				break;
			case "BINARY":
				if (instruction.operator === "in" || instruction.operator === "instanceof") {
					disqualUse.add(instruction.left);
					disqualUse.add(instruction.right);
				} else if (UNAMBIGUOUS_NUMERIC_BINARY.has(instruction.operator)) {
					numericUse.add(instruction.left);
					numericUse.add(instruction.right);
				}
				// `+` and the equality operators are neutral
				break;
			case "UNARY":
				if (
					instruction.operator === "-" ||
					instruction.operator === "+" ||
					instruction.operator === "~"
				) {
					numericUse.add(instruction.src);
				} else {
					// !, typeof, void, delete — not numeric
					disqualUse.add(instruction.src);
				}
				break;
			default:
				// An opcode the backend can't lower yet: the function won't compile.
				return new Set();
		}
	}

	const promotable = new Set<number>();
	for (let p = 0; p < paramCount; p++) {
		// Walk the forward MOVE closure of the parameter — the registers its value
		// may reach. Register reuse can make this over-approximate, which only
		// costs a missed or wasted promotion, never correctness: the entry guard
		// makes any promotion sound regardless of how the parameter is used.
		const seen = new Set<number>([p]);
		const stack = [p];
		let justified = false;
		let disqualified = false;
		while (stack.length > 0) {
			const r = stack.pop()!;
			if (disqualUse.has(r)) {
				disqualified = true;
				break;
			}
			if (numericUse.has(r)) {
				justified = true;
			}
			for (const target of moveTargets.get(r) ?? []) {
				if (!seen.has(target)) {
					seen.add(target);
					stack.push(target);
				}
			}
		}
		if (justified && !disqualified) {
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
): CompiledFunction | null {
	// Generators and async functions suspend mid-body: they lower to a resumable C
	// function (a heap register frame + entry dispatch to the saved resume point)
	// rather than the straight-line shape below (see emitResumableFunction). (override
	// is only ever set for the boxed fallback of a promoting normal function, never a
	// coroutine.)
	if (fn.isGenerator || fn.isAsync) {
		return emitResumableFunction(fn, index, suffix, debug);
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
	const totalSlots = slotCount + (fn.isDerivedConstructor ? 1 : 0);

	// `with` pushes an object environment record onto the `env` chain (WITH_ENTER),
	// so a with-function reassigns `env` and needs the root frame to keep the live
	// with-env rooted (the with-object is live across property accesses in the body).
	const hasWith = fn.instructions.some((i) => i.opcode === "WITH_ENTER");

	// A root frame is needed to scan MalValue registers, a derived constructor's
	// `this`, this activation's captured env, and/or a reassigned `with` env; every
	// exit past its link must unlink it.
	const needsRootFrame = totalSlots > 0 || capturesEnv || hasWith;
	const gcUnlink = needsRootFrame ? "mal_root_frame_head = __gc_frame.prev; " : "";

	const body = emitBody(fn, suffix, reps, debug, gcUnlink, thisSlot, null);
	if (body === null) {
		return null;
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

	const symbol = override?.symbol ?? `mal_compiled_${index}${suffix}`;

	// PARAM-BAIL FALLBACK: when this variant speculatively unboxes params, its
	// entry guard must have somewhere to go when an argument is not a number.
	// Rather than re-enter the bytecode interpreter (which would keep the whole
	// interpreter live), emit a second, fully-boxed variant of this same function
	// and jump there. That variant promotes nothing, so it never bails — no
	// compiled function depends on the interpreter, and the bytecode overlay can
	// be dropped for every compiled function.
	let fallbackSource = "";
	let bailTarget = "";
	if (promotedParams.length > 0) {
		const boxedSymbol = `mal_compiled_${index}_boxed${suffix}`;
		const boxed = emitCompiledFunction(fn, index, suffix, debug, {
			symbol: boxedSymbol,
			promotable: new Set(),
		});
		if (boxed === null) {
			return null; // the promoting variant lowered, so this cannot happen
		}
		fallbackSource = `${boxed.source}\n\n`;
		bailTarget = `${boxedSymbol}(vm, this_value, args, arg_count, new_target, env, callee, resume_state)`;
	}

	const lines: Array<string> = [];

	lines.push(
		`static MalValue ${symbol}(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalEnv *env, MalValue callee, struct MalGeneratorObject *resume_state) {`,
	);
	lines.push(`    (void) this_value;`);
	lines.push(`    (void) new_target;`);
	lines.push(`    (void) env;`);
	lines.push(`    (void) callee;`);
	lines.push(`    (void) resume_state;`);

	// Registers are plain C locals: `number`-rep ones as doubles, `boolean`-rep
	// as bool (both unboxed). MalValue-rep registers instead alias slots of the
	// root-frame array so the collector can scan them; the `#define` keeps the
	// `r<i>` spelling used throughout the body. The macros are #undef'd at the end
	// of the function (the batch path emits many functions into one unit).
	if (totalSlots > 0) {
		lines.push(`    MalValue __gc_slots[${totalSlots}];`);
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
		for (const i of promotedParams) {
			lines.push(
				`    MalValue p${i} = arg_count > ${i} ? args[${i}] : MAL_VALUE_UNDEFINED;`,
			);
		}
		const guard = promotedParams.map((i) => `!mal_ops_is_number(p${i})`).join(" || ");
		lines.push(`    if (${guard}) {`, `        return ${bailTarget};`, `    }`);
		for (const i of promotedParams) {
			lines.push(`    r${i} = mal_ops_number_as_f64(p${i});`);
		}
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
	// A derived constructor's rooted `this` slot starts as the (EMPTY) parameter.
	if (thisSlot >= 0) {
		lines.push(`    __gc_slots[${thisSlot}] = this_value;`);
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

	return { symbol, source: fallbackSource + lines.join("\n") };
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

	const coro: CoroutineContext = {
		functionIndex: index,
		selfSlot,
		isAsyncFunction,
		isAsyncGenerator,
	};

	// thisSlot is -1: a coroutine is never a derived constructor, and `this` is read
	// from the this_value parameter (which the resume path is invoked with from the
	// saved frame), so no mutable this-slot is needed.
	const body = emitBody(fn, suffix, reps, debug, gcUnlink, -1, coro);
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
		`static MalValue ${symbol}(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalEnv *env, MalValue callee, struct MalGeneratorObject *resume_state) {`,
	);
	lines.push(`    (void) this_value;`);
	lines.push(`    (void) new_target;`);

	lines.push(`    MalValue *__gc_slots;`);
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

	return { symbol, source: lines.join("\n") };
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
			return "number";
		case "CREATE_BOOLEAN":
			return "boolean";
		case "GUARD_FUNCTION_INDEX":
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
				instruction.operator === "~"
			) {
				const src = reps[instruction.src] ?? null;
				return src === null ? null : src === "number" ? "number" : "boxed";
			}
			return "boxed";
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
 * access's position in the region's cached-slot array and `commitIps` — set only on the
 * run's last access — lists every access ip so the slow path can commit the region cache.
 */
interface RegionAccess {
	name: string;
	kind: "array" | "object";
	declare: boolean;
	consolidated: boolean;
	slotIndex: number;
	size: number;
	commitIps: Array<number> | null;
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
		`static const MalShape *${reg.name}_sh[MAL_OBJECT_REGION_MAX_SHAPES];`,
		`static MalValue ${reg.name}_key[${reg.size}];`,
		`static u32 ${reg.name}_sl[MAL_OBJECT_REGION_MAX_SHAPES * ${reg.size}];`,
		`static u32 ${reg.name}_n;`,
		`MalObject *${reg.name}_o = mal_vm_as_object(${objExpr});`,
		// Resolve the matched variant's slot row to a pointer ONCE (offset amortized over the
		// run), so each access is a direct `_slp[i]` — no per-access multiply. The primary
		// variant (index 0 — the monomorphic / dominant shape) is a single compare to the base
		// row, so the common case costs exactly the monomorphic form; only other shapes scan.
		`const u32 *${reg.name}_slp;`,
		`if (${reg.name}_o && ${reg.name}_o->shape == ${reg.name}_sh[0]) {`,
		`  ${reg.name}_slp = ${reg.name}_sl;`,
		`} else {`,
		`  int ${reg.name}_v = ${reg.name}_o ? mal_vm_object_region_variant(${reg.name}_o->shape, ${reg.name}_sh, ${reg.name}_n) : -1;`,
		`  ${reg.name}_slp = ${reg.name}_v >= 0 ? &${reg.name}_sl[${reg.name}_v * ${reg.size}] : nullptr;`,
		`}`,
		`bool ${reg.name}_ok = ${reg.name}_slp != nullptr;`,
	];
}

/**
 * Slow-path commit for a consolidated object region, emitted after the run's last access:
 * when the guard missed (`!__rgok`), try to add the object's shape as a new region variant
 * (its per-site ICs having just resolved) so the next matching iteration is consolidated.
 */
function consolidatedRegionCommit(reg: RegionAccess): Array<string> {
	const ptrs = reg.commitIps!.map((i) => `&__ic_${i}`).join(", ");
	return [
		`if (!${reg.name}_ok) mal_vm_object_region_add_variant(${reg.name}_o, (const MalInlineCache *[]){${ptrs}}, ${reg.size}, ${reg.name}_sh, ${reg.name}_sl, ${reg.name}_key, &${reg.name}_n, MAL_OBJECT_REGION_MAX_SHAPES);`,
	];
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
): Array<string> | null {
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
	const handlerForIp = (ip: number): number | undefined => {
		let best: VmExceptionHandler | undefined;
		for (const handler of fn.handlers) {
			if (ip < handler.startIp || ip >= handler.endIp) {
				continue;
			}
			if (
				best === undefined ||
				handler.endIp - handler.startIp < best.endIp - best.startIp
			) {
				best = handler;
			}
		}
		return best?.handlerIp;
	};

	// Guarded property-access regions. Group consecutive LOAD/STORE_PROPERTY on the same
	// object register within a straight-line window under one hoisted receiver guard: an
	// index-form (number-rep key) run guards a dense array (`mal_vm_as_array`), a string-key
	// run guards a plain object (`mal_vm_as_object`). The first access declares the guard
	// local, the rest reuse it, and each access omits the per-access throwCheck on a fast hit
	// (a dense element / a monomorphic data-slot access runs no user code). A run is
	// homogeneous in kind (array vs object need different guards) and bounded by a label
	// (control could enter without passing the guard), a redefinition of the guarded
	// register, or a control-flow terminator. The guard survives calls/allocations inside
	// the run (the receiver's heap type is invariant, the collector is non-moving, the
	// register keeps it rooted) and each access re-reads shape/elements fresh, so a run need
	// not be safepoint-free.
	const regionGuard = new Map<number, RegionAccess>();
	{
		// First collect maximal runs of same-kind, same-register accesses, then assign each
		// run its region info. A run ends at a label, a redefinition of the accessed
		// register, or a control-flow terminator.
		interface Run {
			reg: number;
			kind: "array" | "object";
			ips: Array<number>;
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
			if (instr.opcode === "LOAD_PROPERTY" || instr.opcode === "STORE_PROPERTY") {
				const kind = reps[instr.key] === "number" ? "array" : "object";
				const obj = instr.object;
				if (cur !== null && cur.reg === obj && cur.kind === kind) {
					cur.ips.push(ip);
				} else {
					flush();
					cur = { reg: obj, kind, ips: [ip] };
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
			const name = `__rg${guardId++}`;
			// A ≥2-access object run consolidates onto ONE shape guard + a cached-slot array;
			// arrays and single object accesses keep the per-access guarded form.
			const consolidated = run.kind === "object" && run.ips.length >= 2;
			run.ips.forEach((ip, i) => {
				regionGuard.set(ip, {
					name,
					kind: run.kind,
					declare: i === 0,
					consolidated,
					slotIndex: i,
					size: run.ips.length,
					commitIps: consolidated && i === run.ips.length - 1 ? run.ips : null,
				});
			});
		}
	}

	const lines: Array<string> = [];
	// Statement-granular source position for this compiled frame: write it into
	// the native frame whenever it changes, so a stack capture taken anywhere in
	// this function (or in a callee/throw) reads the right line. The native frame
	// is guaranteed present (enter_compiled pushed it before this function ran).
	let lastPos = -1;
	for (let ip = 0; ip < fn.instructions.length; ip++) {
		if (jumpTargets.has(ip)) {
			lines.push(`L${ip}:;`);
			// Control can arrive from a jump with a different last-written
			// position, so force the next change to re-emit.
			lastPos = -1;
		}

		if (debug) {
			const pos = fn.positions[ip] ?? -1;
			if (pos !== -1 && pos !== lastPos) {
				lines.push(`    vm->native_frames[vm->native_frame_count - 1].pos_id = ${pos};`);
				lastPos = pos;
			}
		}

		const emitted = emitInstruction(
			fn.instructions[ip]!,
			ip,
			suffix,
			reps,
			fn.strict,
			handlerForIp(ip),
			gcUnlink,
			thisSlot,
			coro,
			regionGuard.get(ip),
		);
		if (emitted === null) {
			return null;
		}
		for (const line of emitted) {
			lines.push(`    ${line}`);
		}
	}

	return lines;
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
	region: RegionAccess | undefined,
): Array<string> | null {
	// Read register r as a boxed MalValue (boxing a number-rep double or a
	// boolean-rep bool).
	const boxed = (r: number): string =>
		reps[r] === "number"
			? `mal_ops_number_value(r${r})`
			: reps[r] === "boolean"
				? `mal_value_new_boolean(r${r})`
				: `r${r}`;
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

	// GC safepoint poll. Emitted at call returns and loop
	// back-edges so a compiled function is interruptible for collection. Near-free
	// until the collector raises mal_gc_poll (always false until Phase 3).
	const poll = "if (mal_gc_poll) mal_gc_safepoint(vm);";

	// Where `this` is stored: a derived constructor's is a mutable rooted slot
	// (super() rebinds it); everything else reads the immutable `this_value` param.
	const thisRef = thisSlot >= 0 ? `__gc_slots[${thisSlot}]` : "this_value";

	switch (instruction.opcode) {
		case "MOVE": {
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
				`mal_vm_op_throw_if_tdz(vm, ${boxed(instruction.src)}, ${instruction.nameStringIndex});`,
				throwCheck,
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
			return [`r${instruction.dst} = mal_vm_op_create_object(vm);`];
		case "CREATE_OBJECT_SHAPED": {
			// Build the literal's shape once (static per-site cache) and create the
			// object directly in it, bulk-filling slots — no per-property defines.
			const keys = instruction.keyStringIndices
				.map((ki) => `&mal_strings${suffix}[${ki}]`)
				.join(", ");
			const values = instruction.valueRegisters.map((r) => boxed(r)).join(", ");
			return [
				`static MalShape *__oshape_${ip} = nullptr;`,
				`if (__oshape_${ip} == nullptr) __oshape_${ip} = mal_shape_from_string_keys((MalString *[]){ ${keys} }, ${instruction.count});`,
				`r${instruction.dst} = mal_vm_create_object_shaped(vm, __oshape_${ip}, (MalValue[]){ ${values} }, ${instruction.count});`,
			];
		}
		case "CREATE_ARRAY":
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
				`mal_vm_op_define_property(vm, ${boxed(instruction.object)}, ${boxed(instruction.key)}, ${boxed(instruction.value)}, ${instruction.enumerable});`,
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
				`r${instruction.dst} = mal_vm_callee_has_index(${boxed(instruction.callee)}, ${instruction.functionIndex});`,
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
		case "LOAD_PROPERTY": {
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
				kind: reps[instruction.key] === "number" ? "array" : "object",
				declare: true,
				consolidated: false,
				slotIndex: 0,
				size: 1,
				commitIps: null,
			};
			if (reg.kind === "array") {
				return [
					...(reg.declare
						? [
								`MalArrayObject *${reg.name} = mal_vm_as_array(${boxed(instruction.object)});`,
							]
						: []),
					`static MalInlineCache __ic_${ip};`,
					`MalValue __v_${ip};`,
					`if (${reg.name} && mal_vm_array_try_load(${reg.name}, ${num(instruction.key)}, &__v_${ip})) {`,
					`  r${instruction.dst} = __v_${ip};`,
					`} else {`,
					`  r${instruction.dst} = mal_vm_array_fast_load_index(vm, ${boxed(instruction.object)}, ${num(instruction.key)}, &__ic_${ip});`,
					`  ${throwCheck}`,
					`}`,
				];
			}
			if (!reg.consolidated) {
				return [
					...(reg.declare
						? [`MalObject *${reg.name} = mal_vm_as_object(${boxed(instruction.object)});`]
						: []),
					`static MalInlineCache __ic_${ip};`,
					`MalValue __v_${ip};`,
					`if ((${reg.name} && mal_vm_object_try_load(${reg.name}, ${boxed(instruction.key)}, &__ic_${ip}, &__v_${ip})) || mal_vm_inherited_try_load(${boxed(instruction.object)}, ${boxed(instruction.key)}, &__ic_${ip}, &__v_${ip})) {`,
					`  r${instruction.dst} = __v_${ip};`,
					`} else {`,
					`  r${instruction.dst} = mal_vm_op_load_property_ic(vm, ${boxed(instruction.object)}, ${boxed(instruction.key)}, &__ic_${ip});`,
					`  ${throwCheck}`,
					`}`,
				];
			}
			// Consolidated object region: one shape guard (__rgok) covers the run; a hit is a
			// direct cached-slot read (key compare guards a computed-key mismatch), a miss the
			// per-access IC. The run's last access commits the cache on the slow path.
			return [
				...(reg.declare ? consolidatedRegionDeclare(reg, boxed(instruction.object)) : []),
				`static MalInlineCache __ic_${ip};`,
				`MalValue __v_${ip};`,
				`if (${reg.name}_ok && ${boxed(instruction.key)} == ${reg.name}_key[${reg.slotIndex}]) {`,
				`  __v_${ip} = ${reg.name}_o->slots[${reg.name}_slp[${reg.slotIndex}]];`,
				`} else {`,
				`  __v_${ip} = mal_vm_op_load_property_ic(vm, ${boxed(instruction.object)}, ${boxed(instruction.key)}, &__ic_${ip});`,
				`  ${throwCheck}`,
				`}`,
				`r${instruction.dst} = __v_${ip};`,
				...(reg.commitIps ? consolidatedRegionCommit(reg) : []),
			];
		}
		case "STORE_PROPERTY": {
			// See LOAD_PROPERTY: a monomorphic data-slot/dense-element hit runs no user code,
			// so the region form drops the throwCheck on the hit; the general-[[Set]] miss
			// fallback keeps it. Array (number-rep index) vs plain object (string key).
			const reg: RegionAccess = region ?? {
				name: `__rg_s${ip}`,
				kind: reps[instruction.key] === "number" ? "array" : "object",
				declare: true,
				consolidated: false,
				slotIndex: 0,
				size: 1,
				commitIps: null,
			};
			if (reg.kind === "array") {
				return [
					...(reg.declare
						? [
								`MalArrayObject *${reg.name} = mal_vm_as_array(${boxed(instruction.object)});`,
							]
						: []),
					`static MalInlineCache __ic_${ip};`,
					`if (!(${reg.name} && mal_vm_array_try_store(${reg.name}, ${num(instruction.key)}, ${boxed(instruction.value)}))) {`,
					`  mal_vm_array_fast_store_index(vm, ${boxed(instruction.object)}, ${num(instruction.key)}, ${boxed(instruction.value)}, ${strict}, &__ic_${ip});`,
					`  ${throwCheck}`,
					`}`,
				];
			}
			if (!reg.consolidated) {
				return [
					...(reg.declare
						? [`MalObject *${reg.name} = mal_vm_as_object(${boxed(instruction.object)});`]
						: []),
					`static MalInlineCache __ic_${ip};`,
					`if (!(${reg.name} && mal_vm_object_try_store(${reg.name}, ${boxed(instruction.key)}, ${boxed(instruction.value)}, &__ic_${ip}))) {`,
					`  mal_vm_op_store_property_ic(vm, ${boxed(instruction.object)}, ${boxed(instruction.key)}, ${boxed(instruction.value)}, ${strict}, &__ic_${ip});`,
					`  ${throwCheck}`,
					`}`,
				];
			}
			// Consolidated object region (see LOAD_PROPERTY): a hit is a barriered cached-slot
			// overwrite (the shape guard proved the slot writable-default), a miss the IC.
			return [
				...(reg.declare ? consolidatedRegionDeclare(reg, boxed(instruction.object)) : []),
				`static MalInlineCache __ic_${ip};`,
				`if (${reg.name}_ok && ${boxed(instruction.key)} == ${reg.name}_key[${reg.slotIndex}]) {`,
				`  mal_vm_object_slot_store(${reg.name}_o, ${reg.name}_slp[${reg.slotIndex}], ${boxed(instruction.value)});`,
				`} else {`,
				`  mal_vm_op_store_property_ic(vm, ${boxed(instruction.object)}, ${boxed(instruction.key)}, ${boxed(instruction.value)}, ${strict}, &__ic_${ip});`,
				`  ${throwCheck}`,
				`}`,
				...(reg.commitIps ? consolidatedRegionCommit(reg) : []),
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
		case "CREATE_ARGUMENTS_OBJECT":
			// The unmapped `arguments` object (this engine never maps parameters). A
			// strict function poisons `.callee`; a sloppy one exposes the invoked
			// function, which reaches the compiled frame via the `callee` parameter.
			return [
				`r${instruction.dst} = mal_create_arguments_object(vm, args, arg_count, callee, ${strict});`,
			];
		case "LOAD_ARGUMENT_COUNT":
			return [`r${instruction.dst} = mal_value_from_i32(arg_count);`];
		case "LOAD_ARGUMENT":
			return [
				`r${instruction.dst} = arg_count > ${instruction.index} ? args[${instruction.index}] : MAL_VALUE_UNDEFINED;`,
			];
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

			// The dst is `number`-rep only when the lattice proved both operands are
			// numbers (see producedRep / producesNumberFromNumbers) — emit native
			// arithmetic or a native ToInt32-based bitwise/shift/remainder, all
			// holding their integer-valued results as a double.
			if (reps[dst] === "number") {
				// Bail defensively if the lattice invariant ever breaks.
				if (!leftIsNum || !rightIsNum) {
					return null;
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
					const lowered = [`r${dst} = ${numberGuard} ? ${fast} : ${slow};`];
					if (binaryOpCanThrow(operator)) {
						lowered.push(completionCheck);
					}
					return lowered;
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
		case "UNARY": {
			const { dst, src, operator } = instruction;
			if (reps[dst] === "number") {
				if (reps[src] !== "number") {
					return null;
				}
				// Lattice marks dst `number` only for unary -, +, and ~ over a
				// number. `~` is over ToInt32 (~to_i32 == bit_xor(., -1), the
				// interpreter's MAL_UNARY_BIT_NOT), its int result held as a double.
				if (operator === "~") {
					return [`r${dst} = (f64) (~mal_ops_number_to_i32(${num(src)}));`];
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
		case "CALL": {
			// Marshal argument registers into a temporary array (boxing numbers),
			// then dispatch through mal_vm_call_value, which handles bound, native,
			// compiled and interpreted callees and returns a completion. A throw
			// propagates via vm->completion exactly as the boxed binary ops do.
			const args = instruction.arguments;
			const argsExpr =
				args.length === 0
					? "nullptr"
					: `((MalValue[]){ ${args.map((r) => boxed(r)).join(", ")} })`;
			const tmp = `call_result_${ip}`;
			// A per-site monomorphic call cache: a repeat call to the same compiled callee
			// skips the dispatch chain (see mal_vm_call_cached). The identity guard keeps it
			// sound for bound/native/proxy/interpreted callees (they stay on the slow path).
			return [
				`static MalCallCache __cc_${ip};`,
				`MalCompletion ${tmp} = mal_vm_call_cached(vm, &__cc_${ip}, ${boxed(instruction.callee)}, ${boxed(instruction.thisValue)}, ${argsExpr}, ${args.length});`,
				`if (${tmp}.kind == MAL_COMPLETION_THROW) ${onThrow}`,
				`r${instruction.dst} = ${tmp}.value;`,
				poll, // call-return safepoint
			];
		}
		case "CONSTRUCT": {
			// `new callee(args)`: marshal args (boxing numbers) and dispatch through
			// mal_vm_construct_value, which allocates the instance, runs the
			// constructor (compiled/interpreted/native), and returns the result.
			const args = instruction.arguments;
			const argsExpr =
				args.length === 0
					? "nullptr"
					: `((MalValue[]){ ${args.map((r) => boxed(r)).join(", ")} })`;
			const tmp = `construct_result_${ip}`;
			return [
				`MalCompletion ${tmp} = mal_vm_construct_value(vm, ${boxed(instruction.callee)}, ${argsExpr}, ${args.length});`,
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
			return [
				`MalIteratorRecord ${rec} = { .iterator = ${boxed(instruction.iterator)}, .next_method = ${boxed(instruction.next)} };`,
				`MalValue ${val}; bool ${done};`,
				`if (!mal_vm_iterator_step_fast(vm, &${rec}, &${val}, &${done})) ${onThrow}`,
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
			const value =
				instruction.value < 0 ? "MAL_VALUE_UNDEFINED" : boxed(instruction.value);
			// A coroutine body's return completes the activation: free its buffer and
			// settle its promise / hand the value to the .next() driver.
			if (coro !== null) {
				return [
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
					`MalValue ${ret} = mal_vm_op_derived_construct_return(vm, ${value}, ${thisRef});`,
					throwCheck,
					`${gcUnlink}return ${ret};`,
				];
			}
			// Route through mal_ops_construct_result so a [[Construct]] invocation
			// (new_target set) substitutes `this` for a non-object completion; a
			// plain call passes the value through unchanged.
			return [
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
		case "DEFINE_PRIVATE":
			// AddPrivateName on a fresh instance/class object; a duplicate install throws.
			return [
				`mal_vm_op_define_private(vm, ${boxed(instruction.object)}, ${boxed(instruction.key)}, ${boxed(instruction.value)});`,
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
		case "GENERATOR_START": {
			// Resumable functions only. Build the generator/async-generator instance
			// adopting this activation's buffer, then suspend at the next instruction
			// and hand the generator back to the caller (the first .next() resumes it).
			if (coro === null) {
				return null;
			}
			return [
				`__coro = mal_vm_op_generator_start_compiled(vm, callee, ${coro.functionIndex}, this_value, env, __gc_slots, ${ip + 1}, ${coro.isAsyncGenerator});`,
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
		case "ASYNC_START": {
			// Create the result promise + hidden async state adopting this
			// activation's buffer; unlike GENERATOR_START the body keeps running (no
			// suspend). Every later exit returns the promise (__async_result_promise).
			if (coro === null) {
				return null;
			}
			return [
				`__coro = mal_vm_op_async_start_compiled(vm, ${coro.functionIndex}, this_value, env, __gc_slots, &__async_result_promise);`,
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
