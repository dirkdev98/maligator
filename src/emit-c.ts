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
	/** The full `static MalValue ...(...) { ... }` definition. */
	source: string;
	/**
	 * Whether the compiled body can fall back to the bytecode interpreter at
	 * runtime. Only the speculative param-unboxing guard does so (via
	 * mal_vm_interpret_function); a function with no promoted params never bails,
	 * so its bytecode is dead and can be omitted from the emitted module.
	 */
	bailsToInterpreter: boolean;
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
			case "CREATE_FUNCTION":
			case "CREATE_ARGUMENTS_OBJECT": // reads the raw args, no register operand
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
				disqualUse.add(instruction.object);
				disqualUse.add(instruction.key);
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
): CompiledFunction | null {
	// Generators and async functions suspend mid-body; they are not straight-line
	// C functions (the resumable-compiled-function backend is a later milestone).
	if (fn.isGenerator || fn.isAsync) {
		return null;
	}

	// A derived constructor's `this` starts in a TDZ (uninitialized until super()),
	// enforced only on the interpreter's LOAD_THIS / RETURN paths. Keep derived
	// constructors interpreted so those checks apply. Most already are (they
	// contain constructSuper, which the backend doesn't lower); this also covers
	// the no-super/return-before-super error cases, which otherwise compile.
	if (fn.isDerivedConstructor) {
		return null;
	}

	// A function with its own captured slots needs a per-activation MalEnv node
	// (function_index == this function) for LOAD/STORE_CAPTURED(owner == self) and
	// for the closures it creates to capture. The interpreter's
	// push_function_frame allocates it; the compiled function allocates the same
	// node at entry (below) and reassigns `env` to it, so the body's captured
	// access and CREATE_FUNCTION see this activation's slots.
	const capturesEnv = fn.capturedCount > 0;

	const promotableParams = numericParamCandidates(fn);
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
	// A root frame is needed to scan MalValue registers and/or this activation's
	// captured env; every exit past its link must unlink it.
	const needsRootFrame = slotCount > 0 || capturesEnv;
	const gcUnlink = needsRootFrame ? "mal_root_frame_head = __gc_frame.prev; " : "";

	const body = emitBody(fn, suffix, reps, debug, gcUnlink);
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

	const symbol = `mal_compiled_${index}${suffix}`;
	const lines: Array<string> = [];

	lines.push(
		`static MalValue ${symbol}(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalEnv *env) {`,
	);
	lines.push(`    (void) this_value;`);
	lines.push(`    (void) new_target;`);
	lines.push(`    (void) env;`);

	// Registers are plain C locals: `number`-rep ones as doubles, `boolean`-rep
	// as bool (both unboxed). MalValue-rep registers instead alias slots of the
	// root-frame array so the collector can scan them; the `#define` keeps the
	// `r<i>` spelling used throughout the body. The macros are #undef'd at the end
	// of the function (the batch path emits many functions into one unit).
	if (slotCount > 0) {
		lines.push(`    MalValue __gc_slots[${slotCount}];`);
	}
	for (let i = 0; i < fn.registerCount; i++) {
		const slot = slotOf.get(i);
		if (slot !== undefined) {
			lines.push(`#define r${i} (__gc_slots[${slot}])`);
		} else {
			lines.push(`    ${cTypeOf(reps[i]!)} r${i};`);
		}
	}

	// Promoted parameters: load each boxed, guard that every one is a number,
	// and bail to the interpreter — running THIS function's own bytecode by
	// index — when any is not (a normal call dispatch would re-enter .compiled
	// and loop forever). undefined (incl. a missing argument) is not a number,
	// so under-application bails and interprets identically. Past the guard the
	// fast body runs fully unboxed with no per-op number checks.
	if (promotedParams.length > 0) {
		for (const i of promotedParams) {
			lines.push(
				`    MalValue p${i} = arg_count > ${i} ? args[${i}] : MAL_VALUE_UNDEFINED;`,
			);
		}
		const guard = promotedParams.map((i) => `!mal_ops_is_number(p${i})`).join(" || ");
		lines.push(`    if (${guard}) {`);
		if (debug) {
			// The interpreter's pushed frame represents this function from here;
			// hide the native frame so a capture does not show it twice.
			lines.push(`        mal_vm_compiled_bailed(vm);`);
		}
		lines.push(
			`        return mal_vm_interpret_function(vm, ${index}, MAL_VALUE_UNDEFINED, this_value, args, arg_count, new_target, env);`,
		);
		lines.push(`    }`);
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

	// Publish the root frame first, with every register slot already initialized,
	// so the collector can scan them before any allocation. mal_env_new is now a GC
	// allocation (MalEnv is a cell), so the env is built and linked into the
	// already-published frame afterwards — never held unrooted across a safepoint.
	// The promoted-param bail above returns before this point (no unlink).
	if (needsRootFrame) {
		lines.push(
			`    static const MalFrameDescriptor __gc_desc = { .function_index = ${index}, .slot_count = ${slotCount} };`,
			`    MalRootFrame __gc_frame = { .prev = mal_root_frame_head, .desc = &__gc_desc, .slots = ${slotCount > 0 ? "__gc_slots" : "nullptr"}, .env = nullptr };`,
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

	lines.push(...body);

	// Falling off the end returns undefined — or `this` for a constructor with no
	// explicit object return (mal_ops_construct_result with new_target set).
	lines.push(
		`    ${gcUnlink}return mal_ops_construct_result(MAL_VALUE_UNDEFINED, this_value, new_target);`,
	);
	lines.push("}");
	for (const i of valueRegs) {
		lines.push(`#undef r${i}`);
	}

	return {
		symbol,
		source: lines.join("\n"),
		bailsToInterpreter: promotedParams.length > 0,
	};
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
 * Emit the instruction body, with labels at jump targets and gotos for jumps.
 * Returns null if any instruction is not yet lowerable.
 */
function emitBody(
	fn: VmFunction,
	suffix: string,
	reps: Array<RegisterRep>,
	debug: boolean,
	gcUnlink: string,
): Array<string> | null {
	const jumpTargets = new Set<number>();
	for (const instruction of fn.instructions) {
		if (instruction.opcode === "JUMP" || instruction.opcode === "JUMP_IF") {
			jumpTargets.add(instruction.targetIp);
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
	// On a pending throw with no in-function handler we leave the compiled frame,
	// so unlink its root frame first; a goto to an in-function handler keeps the
	// frame live (no unlink).
	const onThrow =
		handlerIp !== undefined
			? `goto L${handlerIp};`
			: `{ ${gcUnlink}return MAL_VALUE_UNDEFINED; }`;
	const throwCheck = `if (vm->completion.kind == MAL_COMPLETION_THROW) ${onThrow}`;

	// GC safepoint poll. Emitted at call returns and loop
	// back-edges so a compiled function is interruptible for collection. Near-free
	// until the collector raises mal_gc_poll (always false until Phase 3).
	const poll = "if (mal_gc_poll) mal_gc_safepoint(vm);";

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
			return [`r${instruction.dst} = this_value;`];
		case "LOAD_NEW_TARGET":
			return [`r${instruction.dst} = new_target;`];
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
			// A per-site monomorphic inline cache: a static persists across calls and
			// (zero-initialized) starts empty. On a repeat access to the same shape it
			// is a direct slot read with no key conversion or shape search.
			// mal_vm_array_fast_load inlines a dense-array index read ahead of the IC
			// (a non-array / non-index key falls straight through at no real cost).
			return [
				`static MalInlineCache __ic_${ip};`,
				`r${instruction.dst} = mal_vm_array_fast_load(vm, ${boxed(instruction.object)}, ${boxed(instruction.key)}, &__ic_${ip});`,
				throwCheck,
			];
		case "STORE_PROPERTY":
			// mal_vm_array_fast_store inlines a dense-array index store ahead of the IC.
			return [
				`static MalInlineCache __ic_${ip};`,
				`mal_vm_array_fast_store(vm, ${boxed(instruction.object)}, ${boxed(instruction.key)}, ${boxed(instruction.value)}, ${strict}, &__ic_${ip});`,
				throwCheck,
			];
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
				`mal_vm_op_store_global_property(vm, ${instruction.nameStringIndex}, ${boxed(instruction.src)});`,
				throwCheck,
			];
		case "CREATE_ARGUMENTS_OBJECT":
			// The unmapped `arguments` object. A compiled frame does not carry its
			// callee, so only strict functions — whose `callee` is poisoned with
			// %ThrowTypeError% rather than exposing the function — lower here; sloppy
			// functions stay on the interpreter, which has the callee.
			if (!strict) {
				return null;
			}
			return [
				`r${instruction.dst} = mal_create_arguments_object(vm, args, arg_count, MAL_VALUE_UNDEFINED, true);`,
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
				if (leftIsNum !== rightIsNum) {
					const guard = guardIsNumber(leftIsNum ? right : left);
					const fastBool = `${numericOf(left)} ${compare} ${numericOf(right)}`;
					return [
						dstIsBool
							? `r${dst} = ${guard} ? (${fastBool}) : mal_value_to_boolean(${slow});`
							: `r${dst} = ${guard} ? mal_value_new_boolean(${fastBool}) : ${slow};`,
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

			// Mixed rep on a number-producing op: exactly one operand is a proven
			// number, the other boxed. Speculate the boxed operand is a number and
			// take the native double op when it is, else the fully-general op.
			// `mal_ops_number_as_f64` recovers a number's exact f64 and
			// `mal_ops_number_value` re-boxes with the interpreter's int32/-0/NaN
			// canonicalization, so the fast path is observably identical to the
			// fallback — including `%` (mal_number_remainder) and the bitwise/shift
			// ops (ToInt32). (`+` stays correct: a proven number can't be a string,
			// and the guard rejects a boxed string, so the string-concat branch of
			// the slow op is only reached when the native branch is not taken.)
			if (leftIsNum !== rightIsNum) {
				const nativeExpr = nativeNumberExpr(operator, numericOf(left), numericOf(right));
				if (nativeExpr !== null) {
					const guard = guardIsNumber(leftIsNum ? right : left);
					const lines = [
						`r${dst} = ${guard} ? mal_ops_number_value(${nativeExpr}) : ${slow};`,
					];
					if (binaryOpCanThrow(operator)) {
						lines.push(completionCheck);
					}
					return lines;
				}
			}

			// Fully general fallback: both operands boxed, or string/bigint/`in`/
			// `instanceof`. Any non-comparison op can throw (BigInt domain errors),
			// so propagate the completion — previously only `in`/`instanceof` did,
			// which silently swallowed BigInt TypeErrors/RangeErrors here.
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
			return [
				`MalCompletion ${tmp} = mal_vm_call_value(vm, ${boxed(instruction.callee)}, ${boxed(instruction.thisValue)}, ${argsExpr}, ${args.length});`,
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
		case "RETURN":
			// Register -1 is the "no value" sentinel (a synthesized empty return).
			// Route through mal_ops_construct_result so a [[Construct]] invocation
			// (new_target set) substitutes `this` for a non-object completion; a
			// plain call passes the value through unchanged.
			return [
				instruction.value < 0
					? `${gcUnlink}return mal_ops_construct_result(MAL_VALUE_UNDEFINED, this_value, new_target);`
					: `${gcUnlink}return mal_ops_construct_result(${boxed(instruction.value)}, this_value, new_target);`,
			];
		default:
			// Not lowered yet — the function stays on the interpreter. This is the
			// blank to fill in (calls, property access, captures, ...).
			return null;
	}
}

export type { RegisterRep };
