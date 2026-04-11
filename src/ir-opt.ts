import { debugIntermediateProgram } from "./ir.ts";
import type { IntermediateProgram } from "./ir.ts";
import { isNil } from "./utils.ts";

/**
 * Naively execute a few IR optimizations.
 *
 * TODO: We should probably do better optimizations ;)
 *
 * TODO: We should do various verifications on optimizations. i.e does the code actually
 * behave the same?
 */
export function executeIROptimizations(program: IntermediateProgram) {
	const passes = [
		optDropInstructionsAfterJumpsOrReturns,
		optDropUnreferencedBlocks,
		optLocalsToRegister,
	];

	// Run all passes a few times. We can probably do better, but this allows us to be a bit more
	// naive ;)
	for (let i = 0; i < 5; ++i) {
		for (const pass of passes) {
			pass(program);
		}
	}

	debugIntermediateProgram(program);
}

/**
 * Drop all instructions from a block after an unconditional jump or return.
 */
function optDropInstructionsAfterJumpsOrReturns(program: IntermediateProgram) {
	for (const fn of program.functions) {
		for (const block of fn.blocks) {
			for (let i = 0; i < block.instructions.length; ++i) {
				const instruction = block.instructions[i];
				if (!instruction) {
					continue;
				}

				if (instruction.type === "jump" || instruction.type === "return") {
					block.instructions.splice(i + 1);
					return;
				}
			}
		}
	}
}

/**
 * Check if all blocks in the program are referenced. We can assume that all blocks are
 * referenced before we optimize, but in some future cases we might inline blocks or functions.
 */
function optDropUnreferencedBlocks(program: IntermediateProgram) {
	for (const fn of program.functions) {
		const blockIndices = new Set(
			// Note the slice. Our first block is our function entrypoint. If we skip that we skip
			// everything.
			Array.from({ length: fn.blocks.length }, (_, i) => i).slice(1),
		);

		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				if ("blocks" in instruction) {
					for (const blockIdx of instruction.blocks) {
						blockIndices.delete(blockIdx);
					}
				}

				if (blockIndices.size === 0) {
					// 'Early' return if all blocks are referenced.
					break;
				}
			}

			if (blockIndices.size === 0) {
				// 'Early' return if all blocks are referenced.
				break;
			}
		}

		for (const blockIdx of [...blockIndices].toReversed()) {
			fn.blocks.splice(blockIdx, 1);
		}
	}
}

/**
 * Move all local variable usages to use registers.
 */
function optLocalsToRegister(program: IntermediateProgram) {
	for (const fn of program.functions) {
		const localMap = new Map<number, number>();

		for (const block of fn.blocks) {
			for (let i = 0; i < block.instructions.length; ++i) {
				const instruction = block.instructions[i];
				if (instruction?.type !== "storeLocal" && instruction?.type !== "loadLocal") {
					continue;
				}

				let register = localMap.get(instruction.index);
				if (isNil(register)) {
					register = fn.nextRegisterDestination++;
					localMap.set(instruction.index, register);
				}

				if (instruction.type === "loadLocal") {
					block.instructions[i] = {
						type: "move",
						registers: [instruction.registers[0], register],
					};
				} else if (instruction.type === "storeLocal") {
					block.instructions[i] = {
						type: "move",
						registers: [register, instruction.registers[0]],
					};
				}
			}
		}
	}
}
