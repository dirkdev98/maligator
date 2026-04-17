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
		optCombineLinearBlocks,
		optPatchJumpsToDirectJumpBlocks,
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
			// Note the slice. Our first block is our function entrypoint. If we skip that, we skip
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

		for (const blockIdx of blockIndices) {
			// Remove the block
			fn.blocks.splice(blockIdx, 1);

			// Patch up any blocks that reference blocks after the jumpTarget
			for (let i = 0; i < fn.blocks.length; ++i) {
				const block = fn.blocks[i]!;
				for (let j = 0; j < block.instructions.length; ++j) {
					const instruction = block.instructions[j]!;
					if ("blocks" in instruction) {
						for (let k = 0; k < instruction.blocks.length; ++k) {
							if (instruction.blocks[k]! > blockIdx) {
								instruction.blocks[k]!--;
							}
						}
					}
				}
			}
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

/**
 * We can combine linear blocks into a single block, if they are only jumped to from the last
 * instruction of the previous block.
 */
function optCombineLinearBlocks(program: IntermediateProgram) {
	for (const fn of program.functions) {
		const jumpTargetToSources = new Map<number, Array<number>>();

		for (let jumpSource = 0; jumpSource < fn.blocks.length - 1; ++jumpSource) {
			const block = fn.blocks[jumpSource]!;

			for (const instr of block.instructions) {
				if ("blocks" in instr) {
					for (const targetBlock of instr.blocks) {
						const jumpSourceList =
							jumpTargetToSources.get(targetBlock) ??
							jumpTargetToSources.set(targetBlock, []).get(targetBlock)!;

						jumpSourceList.push(jumpSource);
					}
				}
			}
		}

		for (const [jumpTarget, jumpSources] of jumpTargetToSources) {
			if (jumpSources.length !== 1) {
				// For now, we keep it simple and only combine linear jumps to the next block.
				continue;
			}

			const jumpSource = jumpSources[0]!;
			if (jumpSource + 1 !== jumpTarget) {
				// Only combine if the jump is to the next block.
				continue;
			}

			const targetBlock = fn.blocks[jumpTarget]!;
			const sourceBlock = fn.blocks[jumpSource]!;

			const lastSourceInstruction = sourceBlock.instructions.at(-1)!;
			if (
				lastSourceInstruction.type !== "jump" ||
				lastSourceInstruction.blocks[0] !== jumpTarget
			) {
				// Only combine the last instruction of the source block is the jump if it is the jump to
				// the consequent block.
				continue;
			}

			// Drop the target block.
			fn.blocks.splice(jumpTarget, 1);
			// Add instruction to the previous block, while removing the last jump instruction
			sourceBlock.instructions.splice(sourceBlock.instructions.length - 1, 1);
			sourceBlock.instructions.push(...targetBlock.instructions);

			// Patch up blocks that reference blocks after the jumpTarget
			for (let i = 0; i < fn.blocks.length; ++i) {
				const block = fn.blocks[i]!;
				for (let j = 0; j < block.instructions.length; ++j) {
					const instruction = block.instructions[j]!;
					if ("blocks" in instruction) {
						for (let k = 0; k < instruction.blocks.length; ++k) {
							if (instruction.blocks[k]! > jumpTarget) {
								instruction.blocks[k]!--;
							}
						}
					}
				}
			}
		}
	}
}

/**
 *
 */
function optPatchJumpsToDirectJumpBlocks(program: IntermediateProgram) {
	for (const fn of program.functions) {
		const jumpBlockToTarget = new Map<number, number>();

		for (let i = 0; i < fn.blocks.length; i++) {
			const block = fn.blocks[i]!;

			if (block.instructions.length === 1 && block.instructions[0]?.type === "jump") {
				jumpBlockToTarget.set(i, block.instructions[0].blocks[0]);
			}
		}

		// Note that we don't trace through jumpBlockToTarget to compact jump-trains. i.e block 1
		// jumps to 2 and 2 to 3 to compact it as 1 - 3.
		// This is handled by running through the optimizations a few times.
		// At some point we should just handle this tho.

		// Blocks are automatically removed in a different optimization when they are not referenced
		// anymore.

		for (const block of fn.blocks) {
			for (const instr of block.instructions) {
				if ("blocks" in instr) {
					for (let i = 0; i < instr.blocks.length; i++) {
						const targetBlock = instr.blocks[i]!;
						const jumpTarget = jumpBlockToTarget.get(targetBlock);
						if (jumpTarget !== undefined) {
							instr.blocks[i] = jumpTarget;
						}
					}
				}
			}
		}
	}
}
