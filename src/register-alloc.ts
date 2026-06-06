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

/**
 * Naively allocate registers for a function.
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

	const virtualRegisterToRealRegister = new Map<number, number>();
	const freeRegisters = [];
	let highestUsedRegister = -1;

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

				const mappedValue = virtualRegisterToRealRegister.get(virtualRegister);
				if (mappedValue !== undefined) {
					instruction.registers[i] = mappedValue;

					if (instruction === registerLastUsedIn.get(virtualRegister)) {
						// Free the register if this is the last use.
						freeRegisters.push(mappedValue);
					}

					continue;
				}

				if (freeRegisters.length > 0) {
					const isLastUse = instruction === registerLastUsedIn.get(virtualRegister);
					// Don't even claim it if it is the last use.
					const mappedValue = isLastUse ? freeRegisters[0]! : freeRegisters.pop()!;

					instruction.registers[i] = mappedValue;
					virtualRegisterToRealRegister.set(virtualRegister, mappedValue);
				} else {
					const nextRegister = highestUsedRegister + 1;
					highestUsedRegister = nextRegister;

					const isLastUse = instruction === registerLastUsedIn.get(virtualRegister);

					const mappedValue = nextRegister;
					if (isLastUse) {
						freeRegisters.push(mappedValue);
						freeRegisters.sort();
					}

					instruction.registers[i] = mappedValue;
					virtualRegisterToRealRegister.set(virtualRegister, mappedValue);
				}
			}
		}
	}

	fn.nextRegisterDestination = highestUsedRegister + 1;
}
