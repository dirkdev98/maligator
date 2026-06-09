import { emitBinaryOperator, emitIntrinsic } from "./emit-vm.ts";
import type { VmFunction, VmInstruction } from "./lower-vm.ts";

/**
 * The native-C backend: lower an eligible function straight to a C function
 * (no VM dispatch loop), to be installed as MalFunction.compiled. This is the
 * scaffold — only a handful of opcodes are lowered today; everything else makes
 * a function ineligible (it falls back to the interpreter). The structure has
 * the seams the design calls for, left as clearly-marked blanks:
 *
 *   - VALUE REPRESENTATION: every register is "boxed" (a C `MalValue`) for now.
 *     Unboxed reps (Int32/Float64/Bool) plug into `RegisterRep` + the per-op
 *     emitters, which is how the ~60x unboxing win lands later.
 *   - TYPE LATTICE: not yet computed; would annotate each register's rep.
 *   - GUARDS: speculative unboxed fast paths with a boxed fallback go in the
 *     per-op emitters once reps exist.
 *   - OPCODES: emitInstruction returns null for anything not yet handled, which
 *     is exactly the list to extend.
 */

/**
 * How a register's value is held in the emitted C. Today only "boxed"; the
 * unboxed representations are the primary future extension point.
 */
type RegisterRep = "boxed";

export interface CompiledFunction {
	/** The C symbol to install as MalFunction.compiled. */
	symbol: string;
	/** The full `static MalValue ...(...) { ... }` definition. */
	source: string;
}

/** Binary operators that can throw, so they need a completion check after. */
const THROWING_BINARY_OPERATORS = new Set(["in", "instanceof"]);

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

	const body = emitBody(fn, suffix);
	if (body === null) {
		return null;
	}

	// Defensive: a register operand of -1 (a "no register" sentinel beyond the
	// RETURN case handled above) would emit invalid C like `r-1`. Bail to the
	// interpreter rather than emit broken code.
	if (body.some((line) => /\br-\d/.test(line))) {
		return null;
	}

	const symbol = `mal_compiled_${index}${suffix}`;
	const lines: Array<string> = [];

	lines.push(
		`static MalValue ${symbol}(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalEnv *env) {`,
	);
	// `this`, new.target and captured env are unused until those features are
	// lowered; cast to void so the unused-parameter case stays warning-free.
	lines.push(`    (void) this_value;`);
	lines.push(`    (void) new_target;`);
	lines.push(`    (void) env;`);

	// Registers are plain C locals (the win over the interpreter's register
	// array). Parameters adopt the incoming arguments; the rest start undefined.
	if (fn.registerCount > 0) {
		const names = Array.from({ length: fn.registerCount }, (_, i) => `r${i}`);
		lines.push(`    MalValue ${names.join(", ")};`);
	}
	for (let i = 0; i < fn.parameterCount; i++) {
		lines.push(`    r${i} = arg_count > ${i} ? args[${i}] : MAL_VALUE_UNDEFINED;`);
	}
	for (let i = fn.parameterCount; i < fn.registerCount; i++) {
		lines.push(`    r${i} = MAL_VALUE_UNDEFINED;`);
	}

	lines.push(...body);

	// Falling off the end returns undefined (a missing explicit return).
	lines.push(`    return MAL_VALUE_UNDEFINED;`);
	lines.push("}");

	return { symbol, source: lines.join("\n") };
}

/**
 * Emit the instruction body, with labels at jump targets and gotos for jumps.
 * Returns null if any instruction is not yet lowerable.
 */
function emitBody(fn: VmFunction, suffix: string): Array<string> | null {
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

		const emitted = emitInstruction(fn.instructions[ip]!, suffix);
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
 * Lower a single instruction to C, or null if it isn't handled yet. Adding an
 * opcode here (and its unboxed forms later) is the main way this backend grows.
 */
function emitInstruction(
	instruction: VmInstruction,
	suffix: string,
): Array<string> | null {
	switch (instruction.opcode) {
		case "MOVE":
			return [`r${instruction.dst} = r${instruction.src};`];
		case "CREATE_UNDEFINED":
			return [`r${instruction.dst} = MAL_VALUE_UNDEFINED;`];
		case "CREATE_NULL":
			return [`r${instruction.dst} = MAL_VALUE_NULL;`];
		case "CREATE_BOOLEAN":
			return [
				`r${instruction.dst} = mal_value_new_boolean(${instruction.value ? "true" : "false"});`,
			];
		case "CREATE_NUMBER":
			return [`r${instruction.dst} = mal_value_from_i32(${instruction.value});`];
		case "CREATE_F64":
			return [
				`r${instruction.dst} = mal_value_from_f64_convert_nan(${instruction.value.toExponential()});`,
			];
		case "CREATE_STRING":
			// References the baked immortal string emitted in the same TU.
			return [
				`r${instruction.dst} = mal_value_from_string(&mal_strings${suffix}[${instruction.stringIndex}]);`,
			];
		case "LOAD_GLOBAL":
			return [`r${instruction.dst} = vm->globals[${instruction.index}];`];
		case "STORE_GLOBAL":
			return [`vm->globals[${instruction.index}] = r${instruction.src};`];
		case "LOAD_INTRINSIC":
			return [
				`r${instruction.dst} = vm->intrinsics[${emitIntrinsic(instruction.intrinsic)}];`,
			];
		case "BINARY": {
			const lowered = [
				`r${instruction.dst} = mal_vm_binary_op(vm, ${emitBinaryOperator(instruction.operator)}, r${instruction.left}, r${instruction.right});`,
			];
			if (THROWING_BINARY_OPERATORS.has(instruction.operator)) {
				lowered.push(
					`if (vm->completion.kind == MAL_COMPLETION_THROW) return MAL_VALUE_UNDEFINED;`,
				);
			}
			return lowered;
		}
		case "JUMP":
			return [`goto L${instruction.targetIp};`];
		case "JUMP_IF":
			return [
				`if (mal_value_is_truthy(r${instruction.cond})) goto L${instruction.targetIp};`,
			];
		case "RETURN":
			// Register -1 is the "no value" sentinel (e.g. a synthesized empty
			// return), which means undefined.
			return [instruction.value < 0 ? "return MAL_VALUE_UNDEFINED;" : `return r${instruction.value};`];
		default:
			// Not lowered yet — the function stays on the interpreter. This is the
			// blank to fill in (calls, property access, captures, unary, ...).
			return null;
	}
}

// Keep the unused rep type referenced until unboxed reps land.
export type { RegisterRep };
