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
	// naive for now ;)
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
					break;
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

		const indicesToPatch = [...blockIndices].sort((a, b) => a - b);
		for (let patchIndex = 0; patchIndex < indicesToPatch.length; patchIndex++) {
			const blockIdx = indicesToPatch[patchIndex]!;

			// Remove the block
			fn.blocks.splice(blockIdx, 1);

			// Patch up subsequent patch targets, since they refer to the block index before
			// removing a block.
			for (let i = patchIndex + 1; i < indicesToPatch.length; ++i) {
				indicesToPatch[i]!--;
			}

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

		// Normalize to a sorted array from source to target.
		//
		// This allows us to patch up consequent block indices and thus combine multiple blocks in
		// one run.
		const pairsToEvaluate = jumpTargetToSources
			.entries()
			.filter(
				([jumpTarget, jumpSources]) =>
					// Excludes multiple sources to a single target. And only
					// support handling consequent blocks.
					jumpSources.length === 1 && jumpSources[0]! + 1 === jumpTarget,
			)
			.map(
				([jumpTarget, jumpSources]) => [jumpSources[0], jumpTarget] as [number, number],
			)
			.toArray()
			.sort((a, b) => a[0] - b[0]);

		for (
			let evaluationIndex = 0;
			evaluationIndex < pairsToEvaluate.length;
			evaluationIndex++
		) {
			const [jumpSource, jumpTarget] = pairsToEvaluate[evaluationIndex]!;

			const sourceBlock = fn.blocks[jumpSource]!;
			const targetBlock = fn.blocks[jumpTarget]!;

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

			// Patch up all other found pairs. Note that these are sorted in source ascending order
			// and we can't have multiple sources to a single target since we only check the last
			// jump instruction.
			for (
				let patchIdx = evaluationIndex + 1;
				patchIdx < pairsToEvaluate.length;
				++patchIdx
			) {
				const [patchSource, patchTarget] = pairsToEvaluate[patchIdx]!;
				pairsToEvaluate[patchIdx] = [patchSource - 1, patchTarget - 1];
			}

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
 * Trace down jumps to blocks with only a jump instruction. So we don't jump twice.
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

						// Inline the jump if we have matching target.
						if (jumpTarget !== undefined) {
							instr.blocks[i] = jumpTarget;
						}
					}
				}
			}
		}
	}
}
