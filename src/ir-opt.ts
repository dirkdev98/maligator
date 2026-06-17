import { debugIntermediateProgram } from "./ir.ts";
import type { IntermediateProgram, IRFunction, IRInstruction } from "./ir.ts";
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
	// Eliminate provably-redundant temporal-dead-zone checks before the main
	// fixpoint. It needs to see the original `loadLocal`/`storeLocal` form
	// (optLocalsToRegister below rewrites those into `move`s), so it runs once
	// up front against the pristine IR.
	optEliminateRedundantTdzChecks(program);

	const passes = [
		optDropInstructionsAfterJumpsOrReturns,
		optDropUnreferencedBlocks,
		optLocalsToRegister,
		optCombineLinearBlocks,
		optPatchJumpsToDirectJumpBlocks,
	];

	// Run all passes until a full round no longer changes the program. The cap is a safety net
	// against passes that endlessly flip-flop the IR.
	const maxRounds = 20;
	for (let round = 0; round < maxRounds; ++round) {
		let changed = false;
		for (const pass of passes) {
			changed = pass(program) || changed;
		}

		if (!changed) {
			break;
		}
	}

	debugIntermediateProgram(program);
}

/**
 * Drop all instructions from a block after an unconditional jump or return.
 */
function optDropInstructionsAfterJumpsOrReturns(program: IntermediateProgram): boolean {
	let changed = false;

	for (const fn of program.functions) {
		for (const block of fn.blocks) {
			for (let i = 0; i < block.instructions.length; ++i) {
				const instruction = block.instructions[i];
				if (!instruction) {
					continue;
				}

				if (
					instruction.type === "jump" ||
					instruction.type === "return" ||
					instruction.type === "throw"
				) {
					if (i + 1 < block.instructions.length) {
						block.instructions.splice(i + 1);
						changed = true;
					}
					break;
				}
			}
		}
	}

	return changed;
}

/**
 * Check if all blocks in the program are referenced. We can assume that all blocks are
 * referenced before we optimize, but in some future cases we might inline blocks or functions.
 */
function optDropUnreferencedBlocks(program: IntermediateProgram): boolean {
	let changed = false;

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
		if (indicesToPatch.length > 0) {
			changed = true;
		}

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

	return changed;
}

/**
 * Move all local variable usages to use registers.
 */
function optLocalsToRegister(program: IntermediateProgram): boolean {
	let changed = false;

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
					changed = true;
				} else if (instruction.type === "storeLocal") {
					block.instructions[i] = {
						type: "move",
						registers: [register, instruction.registers[0]],
					};
					changed = true;
				}
			}
		}
	}

	return changed;
}

/**
 * We can combine linear blocks into a single block, if they are only jumped to from the last
 * instruction of the previous block.
 */
function optCombineLinearBlocks(program: IntermediateProgram): boolean {
	let changed = false;

	for (const fn of program.functions) {
		const jumpTargetToSources = new Map<number, Array<number>>();

		// Scan every block (including the last) so a target's source count is
		// accurate. A back-edge from the final block — e.g. a self-recursive
		// tail-call loop — still makes its target multi-sourced, which must
		// prevent the wrong merge below. (The last block can never be a merge
		// source itself: that needs jumpSource + 1 === jumpTarget.)
		for (let jumpSource = 0; jumpSource < fn.blocks.length; ++jumpSource) {
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
			changed = true;

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

	return changed;
}

/**
 * Eliminate temporal-dead-zone checks that are provably redundant.
 *
 * Every read of a `let`/`const`/class binding emits a `throwIfTdz` against the
 * uninitialized ("empty") sentinel, and every block scope seeds its bindings
 * with a `createEmpty` hole-init. For the overwhelmingly common case — a binding
 * declared-with-initializer (or a loop variable) read only after that store —
 * the check can never fire. Removing it both drops a per-read instruction from
 * the interpreter's hot loop and, crucially, removes the only constructs
 * (`createEmpty` / `throwIfTdz`) the native (emit-c) backend cannot lower, so the
 * whole function becomes eligible and its loop counters can stay unboxed.
 *
 * Soundness: a `throwIfTdz` is dropped only where a forward must-analysis proves
 * the slot is definitely initialized (a non-empty store dominates the read on
 * every path). The analysis is restricted to function-local slots
 * (`loadLocal`/`storeLocal`); captured and global bindings can be initialized by
 * another function, so their checks are left alone. Exception-handler edges are
 * treated conservatively (the handler entry sees nothing as initialized).
 */
function optEliminateRedundantTdzChecks(program: IntermediateProgram) {
	for (const fn of program.functions) {
		eliminateRedundantTdzChecksInFunction(fn);
	}
}

function eliminateRedundantTdzChecksInFunction(fn: IRFunction) {
	const blocks = fn.blocks;
	if (blocks.length === 0) {
		return;
	}

	// `with` (sloppy mode) introduces the empty sentinel through `withGet`, which
	// would defeat the empty-value tracking below. Such functions are never
	// native-backend eligible anyway, so skip them outright.
	for (const block of blocks) {
		for (const instr of block.instructions) {
			if (instr.type === "withGet" || instr.type === "withEnter") {
				return;
			}
		}
	}

	// Blocks reached by a non-local edge (exception handler / tryEnd marker) are
	// pinned to "nothing initialized": a throw can arrive before any store ran.
	const pinnedEmpty = new Set<number>();
	const allSlots = new Set<number>();
	for (const block of blocks) {
		for (const instr of block.instructions) {
			if (instr.type === "tryBegin") {
				for (const target of instr.blocks) {
					pinnedEmpty.add(target);
				}
			} else if (instr.type === "storeLocal" || instr.type === "loadLocal") {
				allSlots.add(instr.index);
			}
		}
	}
	if (allSlots.size === 0) {
		return;
	}

	// Forward must-analysis: inSets[b] = local slots definitely initialized on
	// entry to b. Entry/exception blocks start empty; the rest start at top (all
	// slots) and are intersected down to a fixpoint. A `jumpIf` continues in-block
	// when not taken, so it is a branch — not a terminator.
	const inSets: Array<Set<number>> = blocks.map((_, b) =>
		b === 0 || pinnedEmpty.has(b) ? new Set<number>() : new Set(allSlots),
	);

	const startSet = (b: number): Set<number> =>
		b === 0 || pinnedEmpty.has(b) ? new Set<number>() : inSets[b]!;

	const propagate = (target: number, set: Set<number>): boolean => {
		if (pinnedEmpty.has(target)) {
			return false;
		}
		const current = inSets[target]!;
		let shrank = false;
		for (const slot of current) {
			if (!set.has(slot)) {
				current.delete(slot);
				shrank = true;
			}
		}
		return shrank;
	};

	let changed = true;
	while (changed) {
		changed = false;
		for (let b = 0; b < blocks.length; b++) {
			const cur = new Set(startSet(b));
			const empties = new Set<number>();
			let terminated = false;
			for (const instr of blocks[b]!.instructions) {
				if (instr.type === "createEmpty") {
					empties.add(instr.registers[0]);
				} else if (instr.type === "storeLocal") {
					if (empties.has(instr.registers[0])) {
						cur.delete(instr.index);
					} else {
						cur.add(instr.index);
					}
				} else if (instr.type === "jumpIf") {
					changed = propagate(instr.blocks[0], cur) || changed;
				} else if (instr.type === "jump") {
					changed = propagate(instr.blocks[0], cur) || changed;
					terminated = true;
					break;
				} else if (instr.type === "return" || instr.type === "throw") {
					terminated = true;
					break;
				}
			}
			if (!terminated && b + 1 < blocks.length) {
				changed = propagate(b + 1, cur) || changed;
			}
		}
	}

	// Removal pass: drop each throwIfTdz whose local slot is definitely
	// initialized at that point. A throwIfTdz always immediately follows the load
	// that produced its register, so the register→slot map is fresh.
	const stillChecked = new Set<number>();
	const removable = new Set<IRInstruction>();
	for (let b = 0; b < blocks.length; b++) {
		const cur = new Set(startSet(b));
		const empties = new Set<number>();
		const regToSlot = new Map<number, number>();
		for (const instr of blocks[b]!.instructions) {
			switch (instr.type) {
				case "createEmpty":
					empties.add(instr.registers[0]);
					break;
				case "storeLocal":
					if (empties.has(instr.registers[0])) {
						cur.delete(instr.index);
					} else {
						cur.add(instr.index);
					}
					break;
				case "loadLocal":
					regToSlot.set(instr.registers[0], instr.index);
					break;
				case "throwIfTdz": {
					const slot = regToSlot.get(instr.registers[0]);
					if (slot === undefined) {
						// A global/captured read — not analyzed here.
					} else if (cur.has(slot)) {
						removable.add(instr);
					} else {
						stillChecked.add(slot);
					}
					break;
				}
			}
		}
	}

	if (removable.size === 0) {
		return;
	}

	// Drop the proven-redundant checks, plus any hole-init whose slot has no
	// surviving check (its empty value can never be observed). The hole-init is
	// always `createEmpty [r]` immediately followed by `storeLocal [r]`.
	for (const block of blocks) {
		const instrs = block.instructions;
		const next: Array<IRInstruction> = [];
		for (let i = 0; i < instrs.length; i++) {
			const instr = instrs[i]!;
			if (instr.type === "throwIfTdz" && removable.has(instr)) {
				continue;
			}
			if (instr.type === "createEmpty") {
				const store = instrs[i + 1];
				if (
					store?.type === "storeLocal" &&
					store.registers[0] === instr.registers[0] &&
					!stillChecked.has(store.index)
				) {
					i++;
					continue;
				}
			}
			next.push(instr);
		}
		block.instructions = next;
	}
}

/**
 * Trace down jumps to blocks with only a jump instruction. So we don't jump twice.
 */
function optPatchJumpsToDirectJumpBlocks(program: IntermediateProgram): boolean {
	let changed = false;

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

						// Inline the jump if we have matching target. Self-jumps (e.g. an empty
						// infinite loop) map to themselves; skip them so the fixpoint terminates.
						if (jumpTarget !== undefined && jumpTarget !== targetBlock) {
							instr.blocks[i] = jumpTarget;
							changed = true;
						}
					}
				}
			}
		}
	}

	return changed;
}
