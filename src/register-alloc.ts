import { debugIntermediateProgram } from "./ir.ts";
import type { IntermediateProgram, IRBlock, IRFunction, IRInstruction } from "./ir.ts";

/**
 * Optimize from virtual registers to VM registers.
 */
export function allocateRegisters(program: IntermediateProgram) {
	for (const fn of program.functions) {
		allocateRegistersForFunction(fn);
	}

	debugIntermediateProgram(program);
}

/** How a register's value is held downstream (drives rep-aware allocation). */
type RegisterRep = "boxed" | "number";

/**
 * IR instructions whose registers[0] is a *source*, not a freshly written
 * destination. Everything else that writes registers[0] is treated as a
 * definition; conservatively over-treating a source as a definition only costs
 * an unboxing, but missing a real definition would be unsound, so this list is
 * kept to clearly source-only ops.
 */
const USE_ONLY_FIRST_REGISTER = new Set([
	"return",
	"throw",
	"jump",
	"jumpIf",
	"storeGlobal",
	"storeCaptured",
	"storeProperty",
	"storeSuperProperty",
	"setPrototype",
	"requireCoercible",
]);

/**
 * IR producers whose result is a native-emittable JS number, used by the
 * native backend. Must match emit-c's notion of a `number` register so a
 * physical register the allocator keeps rep-consistent is inferred the same way.
 */
function producesNumber(
	instruction: IRInstruction,
	repOf: (register: number) => RegisterRep,
): boolean {
	switch (instruction.type) {
		case "createNumber":
		case "createF64":
			return true;
		case "move":
			return repOf(instruction.registers[1]) === "number";
		case "binary": {
			const op = instruction.operator;
			return (
				(op === "+" || op === "-" || op === "*" || op === "/") &&
				repOf(instruction.registers[1]) === "number" &&
				repOf(instruction.registers[2]) === "number"
			);
		}
		case "unary":
			return (
				(instruction.operator === "-" || instruction.operator === "+") &&
				repOf(instruction.registers[1]) === "number"
			);
		default:
			return false;
	}
}

/** The virtual register an instruction defines (writes), or null. */
function definedRegister(instruction: IRInstruction): number | null {
	if (!("registers" in instruction) || USE_ONLY_FIRST_REGISTER.has(instruction.type)) {
		return null;
	}
	const dst = instruction.registers[0];
	return dst !== undefined && dst >= 0 ? dst : null;
}

/**
 * Forward fixpoint over virtual registers: a non-parameter register is `number`
 * iff every instruction that defines it is a native-number producer over
 * `number` registers. Monotone (only demotes), so it converges. Parameters hold
 * boxed incoming arguments, so they start (and stay) `boxed`.
 */
function inferVirtualReps(fn: IRFunction): Map<number, RegisterRep> {
	const reps = new Map<number, RegisterRep>();
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			if (!("registers" in instruction)) {
				continue;
			}
			for (const register of instruction.registers) {
				if (register >= 0 && !reps.has(register)) {
					reps.set(register, register < fn.parameterCount ? "boxed" : "number");
				}
			}
		}
	}

	const repOf = (register: number): RegisterRep => reps.get(register) ?? "boxed";

	let changed = true;
	while (changed) {
		changed = false;
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				const dst = definedRegister(instruction);
				if (dst === null || dst < fn.parameterCount || repOf(dst) !== "number") {
					continue;
				}
				if (!producesNumber(instruction, repOf)) {
					reps.set(dst, "boxed");
					changed = true;
				}
			}
		}
	}

	return reps;
}

/**
 * Allocate registers for a function. Rep-aware: a freed physical register is
 * only reused for a virtual register of the same representation, so each
 * physical register holds a single rep across its life. That lets the native
 * backend keep `number` registers unboxed (in C doubles) instead of having a
 * boolean/object/argument poison a register it shares.
 */
function allocateRegistersForFunction(fn: IRFunction) {
	// Use referential equality to track last use of virtual registers
	const registerLastUsedIn = new Map<number, IRInstruction>();
	const registerUsedInMultipleBlocks = new Map<number, Set<IRBlock>>();

	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			if (!("registers" in instruction)) {
				continue;
			}

			for (const register of instruction.registers) {
				registerLastUsedIn.set(register, instruction);

				const blockSet =
					registerUsedInMultipleBlocks.get(register) ??
					registerUsedInMultipleBlocks.set(register, new Set()).get(register)!;
				blockSet.add(block);
			}
		}
	}

	const virtualReps = inferVirtualReps(fn);
	const repOf = (register: number): RegisterRep => virtualReps.get(register) ?? "boxed";

	const virtualRegisterToRealRegister = new Map<number, number>();
	const freeRegisters: Record<RegisterRep, Array<number>> = { boxed: [], number: [] };
	let highestUsedRegister = -1;

	// A register used in multiple blocks may be live across a loop back edge,
	// which the last-static-use model cannot see; those are never freed. Nor are
	// parameter registers, whose physical register holds a boxed incoming
	// argument and must not be reused for, say, a numeric literal.
	const isFreeable = (virtualRegister: number, instruction: IRInstruction) =>
		virtualRegister >= fn.parameterCount &&
		instruction === registerLastUsedIn.get(virtualRegister) &&
		(registerUsedInMultipleBlocks.get(virtualRegister)?.size ?? 0) <= 1;

	// The VM places arguments in the first registers of the frame. Parameters are
	// compiled to the first virtual registers, so pin them to keep the calling
	// convention intact.
	for (let i = 0; i < fn.parameterCount; ++i) {
		virtualRegisterToRealRegister.set(i, i);
		highestUsedRegister = i;
	}

	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			if (!("registers" in instruction)) {
				continue;
			}

			for (let i = 0; i < instruction.registers.length; ++i) {
				const virtualRegister = instruction.registers[i] ?? -1;

				// Keep unknown values for now as unknown registers.
				if (virtualRegister === -1) {
					continue;
				}

				const rep = repOf(virtualRegister);
				const free = freeRegisters[rep];

				const mappedValue = virtualRegisterToRealRegister.get(virtualRegister);
				if (mappedValue !== undefined) {
					instruction.registers[i] = mappedValue;

					if (isFreeable(virtualRegister, instruction)) {
						// Free the register if this is the last use.
						free.push(mappedValue);
					}

					continue;
				}

				const isLastUse = isFreeable(virtualRegister, instruction);

				let mappedRegister: number;
				if (free.length > 0) {
					// Don't even claim it if it is the last use.
					mappedRegister = isLastUse ? free[0]! : free.pop()!;
				} else {
					mappedRegister = ++highestUsedRegister;
					if (isLastUse) {
						free.push(mappedRegister);
						free.sort((a, b) => a - b);
					}
				}

				instruction.registers[i] = mappedRegister;
				virtualRegisterToRealRegister.set(virtualRegister, mappedRegister);
			}
		}
	}

	fn.nextRegisterDestination = highestUsedRegister + 1;
}
