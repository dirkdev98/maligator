/**
 * Backward live-variable analysis over the IR, keyed on GC safepoints, plus
 * loop back-edge identification.
 *
 *   - C1 root frames: a compiled function must spill to its root frame only the
 *     registers that are *live across a safepoint* (a point where GC can run).
 *     `liveAcrossSafepoint` is exactly that set; the conservative fallback is
 *     "every register live anywhere", which this pass strictly improves on.
 *   - C2 safepoint placement: GC may poll at loop back-edges and call returns;
 *     `findBackEdges` locates the loop back-edges.
 *
 * The pass runs on the IR's current register numbering. Run it BEFORE
 * `allocateRegisters` so each register is a single SSA-ish value (the natural
 * granularity for "which values must survive a collection"); it is still correct
 * after allocation, just coarser (a physical register aliases several values).
 *
 * Soundness bias: the analysis never under-estimates a live range. Unknowns are
 * resolved conservatively (a register treated as both used and defined stays
 * live; any non-allowlisted instruction is a safepoint; exception edges are
 * over-approximated). Over-estimation only inflates root frames; under-estimation
 * would drop a live root, so we never risk it.
 */

import type { IRFunction, IRInstruction, IntermediateProgram } from "./ir.ts";
import { definedRegister } from "./register-alloc.ts";
import { log } from "./utils.ts";

/**
 * Instruction types that provably cannot trigger garbage collection: they
 * neither allocate nor call into JS/runtime code that can. Everything NOT in
 * this allowlist is treated as a safepoint, so a newly added instruction is
 * conservatively a safepoint until proven otherwise.
 *
 * Excluded (i.e. safepoints) and why: every allocating `create*` (string, bigint,
 * array, object, function, ...); `call`/`construct`/spreads (run arbitrary code);
 * property get/set/delete and `toPropertyKey`/`requireCoercible` (getters,
 * setters, proxy traps, ToPrimitive, and error throws all allocate); `binary`/
 * `unary` (valueOf/toString); iterator ops; `await`/`yield` (suspension is a
 * collection point); `throwIfTdz` (allocates the ReferenceError when it fires).
 */
const GC_FREE_INSTRUCTION_TYPES = new Set<IRInstruction["type"]>([
	// Control flow / structural markers — no runtime allocation.
	"jump",
	"jumpIf",
	"return",
	"throw",
	"tryBegin",
	"tryEnd",
	"sourcePos",
	"generatorStart",
	"asyncStart",
	"withExit",
	// Pure scalar producers (NaN-boxed inline values, no heap cell).
	"createNumber",
	"createF64",
	"createBoolean",
	"createNull",
	"createUndefined",
	"createEmpty",
	"isEmpty",
	// Slot moves of already-boxed values (no allocation, no user code).
	"move",
	"loadLocal",
	"storeLocal",
	"loadCaptured",
	"storeCaptured",
	"loadGlobal",
	"storeGlobal",
	"loadThis",
	"loadNewTarget",
	"loadIntrinsic",
]);

/** Whether GC can run at this instruction (so live values must be rooted). */
export function isSafepoint(instruction: IRInstruction): boolean {
	return !GC_FREE_INSTRUCTION_TYPES.has(instruction.type);
}

/**
 * Registers an instruction reads. `definedRegister` identifies the single
 * written register (`registers[0]`, except for the source-only ops); every other
 * non-negative register entry is a use. A register that is both written and read
 * (e.g. an aliased `r = r + x` after allocation) appears as a use via its
 * non-zero-index occurrence, which is correct for liveness.
 */
function usedRegisters(instruction: IRInstruction): Array<number> {
	if (!("registers" in instruction)) {
		return [];
	}
	const registers = instruction.registers as ReadonlyArray<number>;
	const def = definedRegister(instruction);
	const uses: Array<number> = [];
	for (let i = 0; i < registers.length; ++i) {
		const register = registers[i];
		if (register === undefined || register < 0) {
			continue;
		}
		// registers[0] is the definition, not a use, unless this is a source-only
		// op (def === null), where registers[0] IS a use.
		if (i === 0 && def !== null) {
			continue;
		}
		uses.push(register);
	}
	return uses;
}

/** Block-index targets of a control-flow branch (jump / jumpIf). */
function jumpTargets(instruction: IRInstruction): ReadonlyArray<number> {
	if (instruction.type === "jump" || instruction.type === "jumpIf") {
		return instruction.blocks;
	}
	return [];
}

export interface BackEdge {
	/** Block index of the branch instruction's block. */
	from: number;
	/** Block index it jumps back to (the loop header). */
	to: number;
}

/**
 * Loop back-edges: a jump/jumpIf whose target block index is <= the index of the
 * block it lives in. `headerBlocks` collects the
 * targets (loop headers) — the natural places to emit a safepoint poll.
 */
export function findBackEdges(fn: IRFunction): {
	backEdges: Array<BackEdge>;
	headerBlocks: Set<number>;
} {
	const backEdges: Array<BackEdge> = [];
	const headerBlocks = new Set<number>();
	for (let from = 0; from < fn.blocks.length; ++from) {
		for (const instruction of fn.blocks[from]!.instructions) {
			for (const to of jumpTargets(instruction)) {
				if (to >= 0 && to <= from) {
					backEdges.push({ from, to });
					headerBlocks.add(to);
				}
			}
		}
	}
	return { backEdges, headerBlocks };
}

/**
 * Control-flow successors of every block. Normal edges: branch targets plus a
 * fall-through to block i+1 unless the block ends in an unconditional leave
 * (jump / return / throw). Exception edges: in any function containing a try, the
 * handler and try-end blocks of every `tryBegin` are added as successors of every
 * block — a sound over-approximation (a throw can reach a handler from anywhere
 * in the protected region; modeling the exact region precisely is deferred).
 */
function computeSuccessors(fn: IRFunction): Array<Array<number>> {
	const blockCount = fn.blocks.length;
	const isValid = (index: number) => index >= 0 && index < blockCount;

	const exceptionalSuccessors: Array<number> = [];
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			if (instruction.type === "tryBegin") {
				for (const target of instruction.blocks) {
					if (isValid(target)) {
						exceptionalSuccessors.push(target);
					}
				}
			}
		}
	}

	return fn.blocks.map((block, index) => {
		const successors = new Set<number>();
		for (const instruction of block.instructions) {
			for (const target of jumpTargets(instruction)) {
				if (isValid(target)) {
					successors.add(target);
				}
			}
		}
		const last = block.instructions[block.instructions.length - 1];
		const leavesUnconditionally =
			last !== undefined &&
			(last.type === "jump" || last.type === "return" || last.type === "throw");
		if (!leavesUnconditionally && isValid(index + 1)) {
			successors.add(index + 1);
		}
		for (const target of exceptionalSuccessors) {
			successors.add(target);
		}
		return [...successors];
	});
}

/** Apply a block's backward transfer to a live-out set, returning its live-in. */
function transferBlock(
	fn: IRFunction,
	blockIndex: number,
	liveOut: Set<number>,
): Set<number> {
	const live = new Set(liveOut);
	const instructions = fn.blocks[blockIndex]!.instructions;
	for (let i = instructions.length - 1; i >= 0; --i) {
		const instruction = instructions[i]!;
		const def = definedRegister(instruction);
		if (def !== null) {
			live.delete(def);
		}
		for (const use of usedRegisters(instruction)) {
			live.add(use);
		}
	}
	return live;
}

function setsEqual(a: Set<number>, b: Set<number>): boolean {
	if (a.size !== b.size) {
		return false;
	}
	for (const value of a) {
		if (!b.has(value)) {
			return false;
		}
	}
	return true;
}

/**
 * A point where GC can run. Two kinds:
 *   - `alloc-call`: an instruction that can allocate or call into JS (`isSafepoint`).
 *   - `loop-poll`: a back-edge branch (`jump`/`jumpIf` to an index <= its block).
 *     The mutator contract polls here so an allocation-free loop cannot starve a
 *     concurrent collection. It is a collection point even though
 *     the branch itself allocates nothing.
 */
export interface Safepoint {
	blockIndex: number;
	instructionIndex: number;
	kind: "alloc-call" | "loop-poll";
	/**
	 * Registers live across this point: `liveOut \ def`. These are the values that
	 * must be reachable (rooted) through a collection here — the exact per-safepoint
	 * root set a compiled frame populates.
	 */
	live: Set<number>;
}

export interface FunctionLiveness {
	/** Live-in register set per block index. */
	liveInByBlock: Array<Set<number>>;
	/** Live-out register set per block index. */
	liveOutByBlock: Array<Set<number>>;
	/**
	 * Union of every safepoint's `live` set: the registers live across AT LEAST one
	 * safepoint (i.e. live-OUT of it — values a later instruction in THIS function
	 * still consumes). The minimal sound root set *if* every safepoint operation
	 * roots its own operands runtime-side; absent that audit, prefer
	 * `liveOrUsedAtSafepoint`.
	 */
	liveAcrossSafepoint: Set<number>;
	/**
	 * `liveAcrossSafepoint` PLUS the operand registers of each safepoint
	 * instruction. A safepoint's operands (a call's receiver/args, a property
	 * base/key/value, a binary op's operands) are handed to an operation that can
	 * collect, so they must survive that collection even when this function makes
	 * no later use of them. Rooting them in the caller's frame preserves the
	 * invariant the runtime already depends on (the caller keeps an in-flight
	 * call's operands reachable for the callee's `this`/args), so this is the set a
	 * compiled root frame uses today — no runtime-side operand-rooting audit
	 * required. The conservative fallback is "every boxed register".
	 */
	liveOrUsedAtSafepoint: Set<number>;
	/** Every safepoint in the function, in block then instruction order. */
	safepoints: Array<Safepoint>;
	backEdges: Array<BackEdge>;
	headerBlocks: Set<number>;
}

/** Whether this instruction is a loop back-edge branch out of `blockIndex`. */
function isBackEdgeBranch(instruction: IRInstruction, blockIndex: number): boolean {
	for (const target of jumpTargets(instruction)) {
		if (target >= 0 && target <= blockIndex) {
			return true;
		}
	}
	return false;
}

/** Live-variable analysis + back-edge identification for one IR function. */
export function computeFunctionLiveness(fn: IRFunction): FunctionLiveness {
	const blockCount = fn.blocks.length;
	const successors = computeSuccessors(fn);
	const liveInByBlock: Array<Set<number>> = fn.blocks.map(() => new Set<number>());
	const liveOutByBlock: Array<Set<number>> = fn.blocks.map(() => new Set<number>());

	// Backward dataflow to a fixpoint. Iterating blocks in reverse index order
	// propagates most liveness in one sweep (the IR is largely forward-laid-out).
	let changed = true;
	while (changed) {
		changed = false;
		for (let index = blockCount - 1; index >= 0; --index) {
			const liveOut = new Set<number>();
			for (const successor of successors[index]!) {
				for (const register of liveInByBlock[successor]!) {
					liveOut.add(register);
				}
			}
			const liveIn = transferBlock(fn, index, liveOut);
			if (
				!setsEqual(liveOut, liveOutByBlock[index]!) ||
				!setsEqual(liveIn, liveInByBlock[index]!)
			) {
				liveOutByBlock[index] = liveOut;
				liveInByBlock[index] = liveIn;
				changed = true;
			}
		}
	}

	// Re-walk each block backward, seeded by its live-out, to record every
	// safepoint and the registers live across it.
	const liveAcrossSafepoint = new Set<number>();
	const liveOrUsedAtSafepoint = new Set<number>();
	const safepoints: Array<Safepoint> = [];
	for (let index = 0; index < blockCount; ++index) {
		const live = new Set(liveOutByBlock[index]);
		const instructions = fn.blocks[index]!.instructions;
		for (let i = instructions.length - 1; i >= 0; --i) {
			const instruction = instructions[i]!;
			// `live` here is the set live immediately AFTER this instruction.
			const allocOrCall = isSafepoint(instruction);
			const loopPoll = isBackEdgeBranch(instruction, index);
			if (allocOrCall || loopPoll) {
				// `live` is the set live immediately AFTER this instruction (its
				// live-out). The compiled backend emits the call/construct return poll
				// AFTER storing the result into its destination register, so a result
				// that a later instruction consumes is live ACROSS that poll and must
				// be rooted through the collection. (Earlier this excluded the
				// instruction's def, assuming GC only runs *inside* the op before the
				// result is written — true for a property/binary safepoint, but NOT for
				// the post-call poll: that freed a returned-and-used call result under
				// GC pressure — `function f(){return [1,2,3].join(",");}` used by its
				// caller, crashing only under MAL_GC_STRESS.) Keeping the def when it is
				// live-out is sound for every safepoint (rooting a value never hurts); a
				// def dead immediately after the op is simply absent from `live`.
				const across = new Set<number>();
				for (const register of live) {
					across.add(register);
					liveAcrossSafepoint.add(register);
					liveOrUsedAtSafepoint.add(register);
				}
				// The safepoint's own operands are consumed by an operation that can
				// collect, so they must survive it even when dead immediately after
				// (`across`, being live-out, omits them). A loop-poll branch has no
				// such operand obligation, but its uses are harmless to include.
				for (const use of usedRegisters(instruction)) {
					liveOrUsedAtSafepoint.add(use);
				}
				safepoints.push({
					blockIndex: index,
					instructionIndex: i,
					// A back-edge can only be a jump/jumpIf, which never allocates, so
					// the two kinds are disjoint; alloc-call wins if both somehow held.
					kind: allocOrCall ? "alloc-call" : "loop-poll",
					live: across,
				});
			}
			const def = definedRegister(instruction);
			if (def !== null) {
				live.delete(def);
			}
			for (const use of usedRegisters(instruction)) {
				live.add(use);
			}
		}
	}
	// Restore block-then-instruction order (the walk visited instructions in
	// reverse within each block).
	safepoints.sort((a, b) =>
		a.blockIndex !== b.blockIndex
			? a.blockIndex - b.blockIndex
			: a.instructionIndex - b.instructionIndex,
	);

	const { backEdges, headerBlocks } = findBackEdges(fn);
	return {
		liveInByBlock,
		liveOutByBlock,
		liveAcrossSafepoint,
		liveOrUsedAtSafepoint,
		safepoints,
		backEdges,
		headerBlocks,
	};
}

export interface ProgramLiveness {
	/** Keyed by `IRFunction.functionIndex`. */
	byFunction: Map<number, FunctionLiveness>;
}

/** Run the liveness + back-edge analysis over every function in the program. */
export function computeProgramLiveness(program: IntermediateProgram): ProgramLiveness {
	const byFunction = new Map<number, FunctionLiveness>();
	for (const fn of program.functions) {
		byFunction.set(fn.functionIndex, computeFunctionLiveness(fn));
	}
	return { byFunction };
}

const formatSet = (set: Set<number>): string =>
	`{${[...set].sort((a, b) => a - b).join(",")}}`;

/**
 * Render the per-function liveness summary (safepoints, their live sets, and loop
 * back-edges) for debugging. Returns the text and routes it through `log.debug`
 * (gated by MAL_DEBUG), mirroring `debugIntermediateProgram`.
 */
export function debugProgramLiveness(program: IntermediateProgram): string {
	const liveness = computeProgramLiveness(program);
	let output = "";
	for (const fn of program.functions) {
		const fl = liveness.byFunction.get(fn.functionIndex)!;
		output += `fn#${fn.functionIndex} (${fn.blocks.length} blocks)\n`;
		output += `  liveAcrossSafepoint:   ${formatSet(fl.liveAcrossSafepoint)}\n`;
		output += `  liveOrUsedAtSafepoint: ${formatSet(fl.liveOrUsedAtSafepoint)}\n`;
		output += `  backEdges: ${fl.backEdges.map((e) => `${e.from}->${e.to}`).join(", ") || "none"}\n`;
		for (const sp of fl.safepoints) {
			output += `  safepoint b${sp.blockIndex}:${sp.instructionIndex} [${sp.kind}] live=${formatSet(sp.live)}\n`;
		}
	}
	log.debug(output);
	return output;
}
