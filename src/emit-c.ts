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
 * no runtime type checks are needed. (Untyped parameters stay boxed for now;
 * promoting them via a runtime guard is the next extension.)
 *
 * The int32-overflow fix in mal_ops (add/sub/mul now promote to f64) is what
 * makes the unboxed double arithmetic behavior-identical to the interpreter.
 */

/** How a register's value is held in the emitted C. */
type RegisterRep = "boxed" | "number";

export interface CompiledFunction {
	/** The C symbol to install as MalFunction.compiled. */
	symbol: string;
	/** The full `static MalValue ...(...) { ... }` definition. */
	source: string;
}

/** Binary operators that can throw, so they need a completion check after. */
const THROWING_BINARY_OPERATORS = new Set(["in", "instanceof"]);
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

	// Registers are plain C locals: `number`-rep ones as doubles (unboxed),
	// the rest as MalValue. Parameters adopt the incoming arguments (always
	// boxed); other registers start at a rep-appropriate zero value.
	for (let i = 0; i < fn.registerCount; i++) {
		lines.push(`    ${reps[i] === "number" ? "double" : "MalValue"} r${i};`);
	}
	for (let i = 0; i < fn.parameterCount; i++) {
		lines.push(`    r${i} = arg_count > ${i} ? args[${i}] : MAL_VALUE_UNDEFINED;`);
	}
	for (let i = fn.parameterCount; i < fn.registerCount; i++) {
		lines.push(`    r${i} = ${reps[i] === "number" ? "0.0" : "MAL_VALUE_UNDEFINED"};`);
	}

	lines.push(...body);

	// Falling off the end returns undefined (a missing explicit return).
	lines.push(`    return MAL_VALUE_UNDEFINED;`);
	lines.push("}");

	return { symbol, source: lines.join("\n") };
}

/**
 * Forward fixpoint: a register is `number` iff every instruction that writes it
 * is a native-number producer over `number`-rep inputs. Monotone — starts
 * optimistic (parameters excepted, since they hold boxed arguments) and only
 * demotes to `boxed`, so it converges.
 */
function inferReps(fn: VmFunction): Array<RegisterRep> {
	const reps: Array<RegisterRep> = Array.from(
		{ length: fn.registerCount },
		() => "number",
	);
	for (let i = 0; i < fn.parameterCount; i++) {
		reps[i] = "boxed";
	}

	let changed = true;
	while (changed) {
		changed = false;
		for (const instruction of fn.instructions) {
			const dst = writeRegister(instruction);
			if (dst === null || dst < 0 || reps[dst] !== "number") {
				continue;
			}
			if (!producesNumber(instruction, reps)) {
				reps[dst] = "boxed";
				changed = true;
			}
		}
	}

	return reps;
}

/** The register an instruction writes (its dst), or null. */
function writeRegister(instruction: VmInstruction): number | null {
	const dst = (instruction as { dst?: number }).dst;
	return typeof dst === "number" ? dst : null;
}

/** Whether the instruction's result is a native-emittable JS number. */
function producesNumber(instruction: VmInstruction, reps: Array<RegisterRep>): boolean {
	switch (instruction.opcode) {
		case "CREATE_NUMBER":
		case "CREATE_F64":
			return true;
		case "MOVE":
			return reps[instruction.src] === "number";
		case "BINARY":
			return (
				instruction.operator in NATIVE_ARITH &&
				reps[instruction.left] === "number" &&
				reps[instruction.right] === "number"
			);
		case "UNARY":
			return (
				(instruction.operator === "-" || instruction.operator === "+") &&
				reps[instruction.src] === "number"
			);
		default:
			return false;
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

		const emitted = emitInstruction(fn.instructions[ip]!, ip, suffix, reps);
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
): Array<string> | null {
	// Read register r as a boxed MalValue (boxing a number-rep double).
	const boxed = (r: number): string =>
		reps[r] === "number" ? `mal_ops_number_value(r${r})` : `r${r}`;
	// Read register r as a raw double (only valid for a number-rep register).
	const num = (r: number): string => `r${r}`;

	switch (instruction.opcode) {
		case "MOVE":
			return [
				reps[instruction.dst] === "number"
					? `r${instruction.dst} = ${num(instruction.src)};`
					: `r${instruction.dst} = ${boxed(instruction.src)};`,
			];
		case "CREATE_UNDEFINED":
			return [`r${instruction.dst} = MAL_VALUE_UNDEFINED;`];
		case "CREATE_NULL":
			return [`r${instruction.dst} = MAL_VALUE_NULL;`];
		case "CREATE_BOOLEAN":
			return [
				`r${instruction.dst} = mal_value_new_boolean(${instruction.value ? "true" : "false"});`,
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
		case "LOAD_GLOBAL":
			return [`r${instruction.dst} = vm->globals[${instruction.index}];`];
		case "STORE_GLOBAL":
			return [`vm->globals[${instruction.index}] = ${boxed(instruction.src)};`];
		case "LOAD_INTRINSIC":
			return [
				`r${instruction.dst} = vm->intrinsics[${emitIntrinsic(instruction.intrinsic)}];`,
			];
		case "BINARY": {
			if (reps[instruction.dst] === "number") {
				const op = NATIVE_ARITH[instruction.operator];
				// The lattice only marks the dst `number` for these ops over
				// number-rep inputs; bail defensively if that ever breaks.
				if (
					op === undefined ||
					reps[instruction.left] !== "number" ||
					reps[instruction.right] !== "number"
				) {
					return null;
				}
				return [
					`r${instruction.dst} = ${num(instruction.left)} ${op} ${num(instruction.right)};`,
				];
			}
			const compare = NATIVE_COMPARE[instruction.operator];
			if (
				compare !== undefined &&
				reps[instruction.left] === "number" &&
				reps[instruction.right] === "number"
			) {
				return [
					`r${instruction.dst} = mal_value_new_boolean(${num(instruction.left)} ${compare} ${num(instruction.right)});`,
				];
			}
			const lowered = [
				`r${instruction.dst} = mal_vm_binary_op(vm, ${emitBinaryOperator(instruction.operator)}, ${boxed(instruction.left)}, ${boxed(instruction.right)});`,
			];
			if (THROWING_BINARY_OPERATORS.has(instruction.operator)) {
				lowered.push(
					`if (vm->completion.kind == MAL_COMPLETION_THROW) return MAL_VALUE_UNDEFINED;`,
				);
			}
			return lowered;
		}
		case "UNARY": {
			if (reps[instruction.dst] === "number") {
				if (reps[instruction.src] !== "number") {
					return null;
				}
				// Lattice marks dst `number` only for unary - / +.
				return [
					instruction.operator === "-"
						? `r${instruction.dst} = -${num(instruction.src)};`
						: `r${instruction.dst} = ${num(instruction.src)};`,
				];
			}
			const lowered = [
				`r${instruction.dst} = mal_vm_unary_op(vm, ${emitUnaryOperator(instruction.operator)}, ${boxed(instruction.src)});`,
			];
			if (THROWING_UNARY_OPERATORS.has(instruction.operator)) {
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
			return [
				`if (mal_value_is_truthy(${boxed(instruction.cond)})) goto L${instruction.targetIp};`,
			];
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
