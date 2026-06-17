import { emitBinaryOperator, emitIntrinsic, emitUnaryOperator } from "./emit-vm.ts";
import type { VmFunction, VmInstruction } from "./lower-vm.ts";

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

	// A function with its own captured slots needs a per-activation MalEnv node
	// (function_index == this function) for LOAD/STORE_CAPTURED(owner == self)
	// and for closures it creates to capture. The interpreter's
	// push_function_frame allocates that node; the compiled dispatch invokes the
	// function with its creation_env directly and never does, so such a function
	// must stay interpreted. (Functions with captured_count == 0 are unaffected:
	// they create only non-capturing closures, and inner closures read outer
	// scopes through their creation_env, which is set correctly either way.)
	if (fn.capturedCount > 0) {
		return null;
	}

	const promotableParams = numericParamCandidates(fn);
	const reps = inferReps(fn, promotableParams);

	const body = emitBody(fn, suffix, reps, debug);
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
	// as bool (both unboxed), the rest as MalValue.
	for (let i = 0; i < fn.registerCount; i++) {
		lines.push(`    ${cTypeOf(reps[i]!)} r${i};`);
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

	lines.push(...body);

	// Falling off the end returns undefined — or `this` for a constructor with no
	// explicit object return (mal_ops_construct_result with new_target set).
	lines.push(
		`    return mal_ops_construct_result(MAL_VALUE_UNDEFINED, this_value, new_target);`,
	);
	lines.push("}");

	return { symbol, source: lines.join("\n") };
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
			const dst = writeRegister(instruction);
			if (dst === null || dst < 0) {
				continue;
			}
			const produced = producedRep(instruction, reps);
			// A definition whose rep can't be determined yet (an operand is still
			// unknown) is left for a later iteration rather than forced to boxed.
			if (produced === null) {
				continue;
			}
			const joined = joinReps(reps[dst] ?? null, produced);
			if (joined !== reps[dst]) {
				reps[dst] = joined;
				changed = true;
			}
		}
	}

	// A register never written (so never read in well-formed IR) resolves to a
	// boxed undefined.
	return reps.map((rep) => rep ?? "boxed");
}

/** The register an instruction writes (its dst), or null. */
function writeRegister(instruction: VmInstruction): number | null {
	const dst = (instruction as { dst?: number }).dst;
	return typeof dst === "number" ? dst : null;
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
): Array<string> | null {
	const jumpTargets = new Set<number>();
	for (const instruction of fn.instructions) {
		if (instruction.opcode === "JUMP" || instruction.opcode === "JUMP_IF") {
			jumpTargets.add(instruction.targetIp);
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

		const emitted = emitInstruction(fn.instructions[ip]!, ip, suffix, reps, fn.strict);
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
					? `r${instruction.dst} = ${instruction.value.toExponential()};`
					: `r${instruction.dst} = mal_value_from_f64_convert_nan(${instruction.value.toExponential()});`,
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
		case "LOAD_PROPERTY":
			return [
				`r${instruction.dst} = mal_vm_op_load_property(vm, ${boxed(instruction.object)}, ${boxed(instruction.key)});`,
				`if (vm->completion.kind == MAL_COMPLETION_THROW) return MAL_VALUE_UNDEFINED;`,
			];
		case "STORE_PROPERTY":
			return [
				`mal_vm_op_store_property(vm, ${boxed(instruction.object)}, ${boxed(instruction.key)}, ${boxed(instruction.value)}, ${strict});`,
				`if (vm->completion.kind == MAL_COMPLETION_THROW) return MAL_VALUE_UNDEFINED;`,
			];
		case "TO_PROPERTY_KEY":
			return [
				`r${instruction.dst} = mal_vm_op_to_property_key(vm, ${boxed(instruction.object)}, ${boxed(instruction.key)});`,
				`if (vm->completion.kind == MAL_COMPLETION_THROW) return MAL_VALUE_UNDEFINED;`,
			];
		case "LOAD_GLOBAL":
			return [`r${instruction.dst} = vm->globals[${instruction.index}];`];
		case "STORE_GLOBAL":
			return [`vm->globals[${instruction.index}] = ${boxed(instruction.src)};`];
		case "LOAD_INTRINSIC":
			return [
				`r${instruction.dst} = vm->intrinsics[${emitIntrinsic(instruction.intrinsic)}];`,
			];
		case "BINARY": {
			const { dst, left, right, operator } = instruction;
			const leftIsNum = reps[left] === "number";
			const rightIsNum = reps[right] === "number";
			const dstIsBool = reps[dst] === "boolean";
			const arith = NATIVE_ARITH[operator];
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
				if (arith !== undefined) {
					return [`r${dst} = ${num(left)} ${arith} ${num(right)};`];
				}
				const bitwise = NATIVE_BITWISE[operator];
				if (bitwise !== undefined) {
					// JS bitwise ops are over ToInt32; the shifts mask the count to 5
					// bits. The signed-32-bit result becomes a double (boxed back to
					// int32 by mal_ops_number_value, matching the interpreter's ops).
					const right32 =
						operator === "<<" || operator === ">>"
							? `(mal_ops_number_to_i32(${num(right)}) & 0x1F)`
							: `mal_ops_number_to_i32(${num(right)})`;
					return [
						`r${dst} = (f64) (mal_ops_number_to_i32(${num(left)}) ${bitwise} ${right32});`,
					];
				}
				if (operator === ">>>") {
					// Unsigned shift yields a uint32; a value ≥ 2^31 stays an f64 when
					// boxed (mal_ops_number_value), like mal_ops_shift_right_unsigned.
					return [
						`r${dst} = (f64) ((u32) mal_ops_number_to_i32(${num(left)}) >> (mal_ops_number_to_i32(${num(right)}) & 0x1F));`,
					];
				}
				if (operator === "%") {
					return [`r${dst} = fmod(${num(left)}, ${num(right)});`];
				}
				return null;
			}

			const slow = `mal_vm_binary_op(vm, ${emitBinaryOperator(operator)}, ${boxed(left)}, ${boxed(right)})`;
			const completionCheck = `if (vm->completion.kind == MAL_COMPLETION_THROW) return MAL_VALUE_UNDEFINED;`;
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

			// Mixed rep on arithmetic: exactly one operand is a proven number, the
			// other boxed. Speculate the boxed operand is a number and take a native
			// double op when it is, else the fully-general op. `mal_ops_number_as_f64`
			// recovers a number's exact f64 and `mal_ops_number_value` re-boxes with
			// the interpreter's int32/-0/NaN canonicalization, so the fast path is
			// observably identical to the fallback. (`+` stays correct: a proven
			// number can't be a string, and the guard rejects a boxed string.)
			if (leftIsNum !== rightIsNum && arith !== undefined) {
				const guard = guardIsNumber(leftIsNum ? right : left);
				const lines = [
					`r${dst} = ${guard} ? mal_ops_number_value(${numericOf(left)} ${arith} ${numericOf(right)}) : ${slow};`,
				];
				if (binaryOpCanThrow(operator)) {
					lines.push(completionCheck);
				}
				return lines;
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
				lowered.push(
					`if (vm->completion.kind == MAL_COMPLETION_THROW) return MAL_VALUE_UNDEFINED;`,
				);
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
				`if (${tmp}.kind == MAL_COMPLETION_THROW) return MAL_VALUE_UNDEFINED;`,
				`r${instruction.dst} = ${tmp}.value;`,
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
				`if (${tmp}.kind == MAL_COMPLETION_THROW) return MAL_VALUE_UNDEFINED;`,
				`r${instruction.dst} = ${tmp}.value;`,
			];
		}
		case "THROW":
			// Set the throw completion and return; the caller (call/construct
			// dispatch or the run loop) unwinds, exactly as MAL_OP_THROW does. A
			// function with its own try/catch is ineligible (no handler table), so
			// the throw always propagates out of this compiled frame.
			return [
				`vm->completion = (MalCompletion) { .kind = MAL_COMPLETION_THROW, .value = ${boxed(instruction.value)} };`,
				`return MAL_VALUE_UNDEFINED;`,
			];
		case "LOAD_UNDECLARED":
			// An undeclared reference always throws ReferenceError; the helper sets
			// the throw completion, so propagate it (the dst is never read).
			return [
				`mal_vm_op_load_undeclared(vm, ${instruction.nameStringIndex});`,
				`return MAL_VALUE_UNDEFINED;`,
			];
		case "JUMP":
			return [`goto L${instruction.targetIp};`];
		case "JUMP_IF":
			// Branch on a raw bool / native truthiness test — no boxing when the
			// condition is already a boolean-rep (typically a comparison result).
			return [`if (${truthy(instruction.cond)}) goto L${instruction.targetIp};`];
		case "RETURN":
			// Register -1 is the "no value" sentinel (a synthesized empty return).
			// Route through mal_ops_construct_result so a [[Construct]] invocation
			// (new_target set) substitutes `this` for a non-object completion; a
			// plain call passes the value through unchanged.
			return [
				instruction.value < 0
					? "return mal_ops_construct_result(MAL_VALUE_UNDEFINED, this_value, new_target);"
					: `return mal_ops_construct_result(${boxed(instruction.value)}, this_value, new_target);`,
			];
		default:
			// Not lowered yet — the function stays on the interpreter. This is the
			// blank to fill in (calls, property access, captures, ...).
			return null;
	}
}

export type { RegisterRep };
