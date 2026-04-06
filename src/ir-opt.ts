import type { IntermediateProgram } from "./ir.ts";

/**
 * Naively execute a few IR optimizations.
 *
 * TODO: We should probably do better optimizations ;)
 *
 * TODO: We should do various verifications on optimizations. i.e does the code actually behave the
 * same?
 */
export function executeIROptimizations(program: IntermediateProgram) {
	const passes = [optDropInstructionsAfterJumpsOrReturns, optDropUnreferencedBlocks];

	// Run all passes a few times. We can probably do better, but this allows us to be a bit more
	// naive ;)
	for (let i = 0; i < 5; ++i) {
		for (const pass of passes) {
			pass(program);
		}
	}
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
 * Check if all blocks in the program are referenced. We can assume that all blocks are referenced
 * before we optimize, but in some future cases we might inline things.
 */
function optDropUnreferencedBlocks(program: IntermediateProgram) {
	for (const fn of program.functions) {
		const blockIndices = new Set(Array.from({ length: fn.blocks.length }, (_, i) => i));

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
