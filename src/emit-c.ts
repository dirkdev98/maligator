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
 * Whether a binary operator can leave a THROW completion that a boxed fallback
 * must propagate. The comparison operators lower to a pure native compare and
 * never throw; every other operator can — `in`/`instanceof` directly, and
 * arithmetic/bitwise/shift whenever a BigInt operand forces the fully-general
 * path (BigInt/Number mixing → TypeError, BigInt `/0` → RangeError, `>>>` on a
 * BigInt → TypeError). The boxed (and mixed-rep fallback) paths reach that
 * general op, so they need the completion check.
 */
function binaryOpCanThrow(operator: string): boolean {
	return !(operator in NATIVE_COMPARE);
}

/**
 * Emit a compiled C function for `fn`, or null when it uses a construct the
 * backend doesn't lower yet (the caller then leaves it to the interpreter).
 */
export function emitCompiledFunction(
	fn: VmFunction,
	index: number,
	suffix: string,
): CompiledFunction | null {
	// Generators suspend mid-body; they are not straight-line C functions.
	if (fn.isGenerator) {
		return null;
	}

	const reps = inferReps(fn);

	const body = emitBody(fn, suffix, reps);
	if (body === null) {
		return null;
	}

	// Defensive: a register operand of -1 (a "no register" sentinel beyond the
	// RETURN case handled below) would emit invalid C like `r-1`. Bail to the
	// interpreter rather than emit broken code.
	if (body.some((line) => /\br-\d/.test(line))) {
		return null;
	}

	const symbol = `mal_compiled_${index}${suffix}`;
	const lines: Array<string> = [];

	lines.push(
		`static MalValue ${symbol}(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalEnv *env) {`,
	);
	lines.push(`    (void) this_value;`);
	lines.push(`    (void) new_target;`);
	lines.push(`    (void) env;`);

	// Registers are plain C locals: `number`-rep ones as doubles, `boolean`-rep
	// as bool (both unboxed), the rest as MalValue. Parameters adopt the incoming
	// arguments (always boxed); other registers start at a rep-appropriate zero.
	for (let i = 0; i < fn.registerCount; i++) {
		lines.push(`    ${cTypeOf(reps[i]!)} r${i};`);
	}
	for (let i = 0; i < fn.parameterCount; i++) {
		lines.push(`    r${i} = arg_count > ${i} ? args[${i}] : MAL_VALUE_UNDEFINED;`);
	}
	for (let i = fn.parameterCount; i < fn.registerCount; i++) {
		lines.push(`    r${i} = ${zeroOf(reps[i]!)};`);
	}

	lines.push(...body);

	// Falling off the end returns undefined (a missing explicit return).
	lines.push(`    return MAL_VALUE_UNDEFINED;`);
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
 * only move down (unknown → native → boxed), so it converges. Parameters hold
 * incoming (boxed) arguments, so they start — and stay — boxed.
 */
function inferReps(fn: VmFunction): Array<RegisterRep> {
	const reps: Array<RegisterRep | null> = Array.from(
		{ length: fn.registerCount },
		() => null,
	);
	for (let i = 0; i < fn.parameterCount; i++) {
		reps[i] = "boxed";
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
			if (instruction.operator in NATIVE_ARITH) {
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
			if (instruction.operator === "-" || instruction.operator === "+") {
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
): Array<string> | null {
	const jumpTargets = new Set<number>();
	for (const instruction of fn.instructions) {
		if (instruction.opcode === "JUMP" || instruction.opcode === "JUMP_IF") {
			jumpTargets.add(instruction.targetIp);
		}
	}

	const lines: Array<string> = [];
	for (let ip = 0; ip < fn.instructions.length; ip++) {
		if (jumpTargets.has(ip)) {
			lines.push(`L${ip}:;`);
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
		case "LOAD_THIS":
			return [`r${instruction.dst} = this_value;`];
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

			// The dst is `number`-rep only when the lattice proved both operands
			// are numbers and the op is native arithmetic — emit raw doubles.
			if (reps[dst] === "number") {
				// Bail defensively if the lattice invariant ever breaks.
				if (arith === undefined || !leftIsNum || !rightIsNum) {
					return null;
				}
				return [`r${dst} = ${num(left)} ${arith} ${num(right)};`];
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

			// Comparisons yield a boolean and never throw. Emit a native compare
			// when both operands are numbers; speculate when one is a boxed number
			// (well-predicted in a hot loop); else use the fully-general op, whose
			// result is already a boxed boolean.
			if (compare !== undefined) {
				if (leftIsNum && rightIsNum) {
					return [storeBool(`${num(left)} ${compare} ${num(right)}`)];
				}
				if (leftIsNum !== rightIsNum) {
					const guard = guardIsNumber(leftIsNum ? right : left);
					const fastBool = `${numericOf(left)} ${compare} ${numericOf(right)}`;
					return [
						dstIsBool
							? `r${dst} = ${guard} ? (${fastBool}) : mal_value_to_boolean(${slow});`
							: `r${dst} = ${guard} ? mal_value_new_boolean(${fastBool}) : ${slow};`,
					];
				}
				return [
					dstIsBool ? `r${dst} = mal_value_to_boolean(${slow});` : `r${dst} = ${slow};`,
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
				// Lattice marks dst `number` only for unary - / +.
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
		case "JUMP":
			return [`goto L${instruction.targetIp};`];
		case "JUMP_IF":
			// Branch on a raw bool / native truthiness test — no boxing when the
			// condition is already a boolean-rep (typically a comparison result).
			return [`if (${truthy(instruction.cond)}) goto L${instruction.targetIp};`];
		case "RETURN":
			// Register -1 is the "no value" sentinel (a synthesized empty return).
			return [
				instruction.value < 0
					? "return MAL_VALUE_UNDEFINED;"
					: `return ${boxed(instruction.value)};`,
			];
		default:
			// Not lowered yet — the function stays on the interpreter. This is the
			// blank to fill in (calls, property access, captures, ...).
			return null;
	}
}

export type { RegisterRep };
