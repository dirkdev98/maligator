/**
 * Backward live-variable analysis over the IR, keyed on GC safepoints, plus
 * loop back-edge identification.
 *
 *   - C1 root frames: a compiled function must spill to its root frame only the
 *     registers that are *live across a safepoint* (a point where GC can run).
 *     `liveAcrossSafepoint` is exactly that set; the conservative complexity
 *     fallback roots every physical register.
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
 * `unary` (valueOf/toString or a typeof result string); iterator ops;
 * `await`/`yield` (suspension is a collection point); `throwIfTdz` (allocates
 * the ReferenceError when it fires).
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
	"typeofCompare",
	// Slot moves of already-boxed values (no allocation, no user code).
	"move",
	"loadLocal",
	"storeLocal",
	"loadCaptured",
	"storeCaptured",
	"loadGlobal",
	"storeGlobal",
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

/** Default bound for the conservative pre-analysis complexity estimate. */
export const DEFAULT_LIVENESS_COMPLEXITY_LIMIT = 10_000_000;

export interface LivenessOptions {
	/** Primarily useful for diagnostics/tests; production uses the default bound. */
	complexityLimit?: number;
}

interface AnalysisStats {
	handlerCount: number;
	registerCount: number;
}

function analysisStats(fn: IRFunction): AnalysisStats {
	let handlerCount = 0;
	let highestRegister = -1;
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			if (instruction.type === "tryBegin") {
				handlerCount += 1;
			}
			if ("registers" in instruction) {
				for (const register of instruction.registers) {
					if (register > highestRegister) {
						highestRegister = register;
					}
				}
			}
		}
	}

	const declaredCount = fn.nextRegisterDestination;
	const registerCount =
		Number.isSafeInteger(declaredCount) && declaredCount >= 0
			? Math.max(declaredCount, highestRegister + 1)
			: highestRegister + 1;
	return { handlerCount, registerCount };
}

function checkedProduct(values: ReadonlyArray<number>): number | null {
	for (const value of values) {
		if (!Number.isSafeInteger(value) || value < 0) {
			return null;
		}
	}
	let product = 1;
	for (const value of values) {
		if (value !== 0 && product > Number.MAX_SAFE_INTEGER / value) {
			return null;
		}
		product *= value;
	}
	return product;
}

function complexityEstimateFor(fn: IRFunction, stats: AnalysisStats): number | null {
	return checkedProduct([
		fn.blocks.length,
		Math.max(stats.handlerCount, 1),
		Math.max(stats.registerCount, 1),
	]);
}

/**
 * Checked estimate for the potentially expensive set propagation. `null` means
 * the product is not safely representable and therefore requires fallback.
 */
export function estimateLivenessComplexity(fn: IRFunction): number | null {
	return complexityEstimateFor(fn, analysisStats(fn));
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
 * Normal control-flow successors of every block. Exceptional edges are applied
 * at their exact instruction positions by `transferBlock`, rather than at block
 * granularity, so markers in the middle of a block retain precise boundaries.
 */
function computeNormalSuccessors(fn: IRFunction): Array<Array<number>> {
	const blockCount = fn.blocks.length;
	const isValid = (index: number) => index >= 0 && index < blockCount;

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
		return [...successors];
	});
}

/** Instructions that can transfer to an active exception handler. */
function canThrow(instruction: IRInstruction): boolean {
	return instruction.type === "throw" || isSafepoint(instruction);
}

interface ExceptionalControlFlow {
	/** Innermost applicable handler per block/instruction, or null. */
	handlerByInstruction: Array<Array<number | null>>;
	/** Distinct handler blocks on which each block's transfer depends. */
	handlerDependencies: Array<Set<number>>;
}

/**
 * Interpret try markers in the same flattened block/instruction order used by
 * VM lowering. A begin takes effect after its marker and an end stops protecting
 * instructions after its marker. Only blocks[0] is an exception destination;
 * blocks[1] merely keeps the end-marker block reachable through IR cleanup.
 */
function deriveExceptionalControlFlow(fn: IRFunction): ExceptionalControlFlow {
	const handlerByInstruction: Array<Array<number | null>> = [];
	const handlerDependencies = fn.blocks.map(() => new Set<number>());
	const activeHandlers: Array<number> = [];

	for (let blockIndex = 0; blockIndex < fn.blocks.length; ++blockIndex) {
		const instructions = fn.blocks[blockIndex]!.instructions;
		const handlers = new Array<number | null>(instructions.length).fill(null);
		handlerByInstruction.push(handlers);

		for (
			let instructionIndex = 0;
			instructionIndex < instructions.length;
			++instructionIndex
		) {
			const instruction = instructions[instructionIndex]!;
			if (instruction.type === "tryBegin") {
				const handler = instruction.blocks[0];
				if (handler < 0 || handler >= fn.blocks.length) {
					throw new Error(`Unknown handler target block ${handler}`);
				}
				activeHandlers.push(handler);
				continue;
			}
			if (instruction.type === "tryEnd") {
				if (activeHandlers.pop() === undefined) {
					throw new Error("Unbalanced tryEnd marker in liveness analysis");
				}
				continue;
			}

			const handler = activeHandlers[activeHandlers.length - 1];
			if (handler !== undefined && canThrow(instruction)) {
				handlers[instructionIndex] = handler;
				handlerDependencies[blockIndex]!.add(handler);
			}
		}
	}

	if (activeHandlers.length > 0) {
		throw new Error("Unbalanced tryBegin marker in liveness analysis");
	}

	return { handlerByInstruction, handlerDependencies };
}

/** Apply a block's backward transfer to a live-out set, returning its live-in. */
function transferBlock(
	fn: IRFunction,
	blockIndex: number,
	liveOut: Set<number>,
	liveInByBlock: Array<Set<number>>,
	handlerByInstruction: Array<Array<number | null>>,
): Set<number> {
	const live = new Set(liveOut);
	const instructions = fn.blocks[blockIndex]!.instructions;
	for (let i = instructions.length - 1; i >= 0; --i) {
		const instruction = instructions[i]!;
		const def = definedRegister(instruction);
		if (def !== null) {
			live.delete(def);
		}
		const handler = handlerByInstruction[blockIndex]![i];
		if (handler !== null && handler !== undefined) {
			for (const register of liveInByBlock[handler]!) {
				live.add(register);
			}
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
	 * Registers live across this point on either the normal or exceptional edge.
	 * These are the values that must be reachable through a collection here.
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
	/** Whether detailed propagation was skipped in favor of rooting all registers. */
	usedFallback: boolean;
	/** Checked pre-analysis estimate; null means arithmetic overflow. */
	complexityEstimate: number | null;
}

export interface SafepointRoots {
	/** Aggregate roots needed by all safepoints, in current register numbering. */
	registers: Set<number>;
	/** True when `registers` conservatively contains every physical register. */
	usedFallback: boolean;
	/** Checked pre-analysis estimate; null means arithmetic overflow. */
	complexityEstimate: number | null;
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

interface SolvedLiveness {
	liveInByBlock: Array<Set<number>>;
	liveOutByBlock: Array<Set<number>>;
	handlerByInstruction: Array<Array<number | null>>;
}

function solveLiveness(fn: IRFunction): SolvedLiveness {
	const blockCount = fn.blocks.length;
	const successors = computeNormalSuccessors(fn);
	const { handlerByInstruction, handlerDependencies } = deriveExceptionalControlFlow(fn);
	const liveInByBlock: Array<Set<number>> = fn.blocks.map(() => new Set<number>());
	const liveOutByBlock: Array<Set<number>> = fn.blocks.map(() => new Set<number>());

	const predecessors = fn.blocks.map(() => new Set<number>());
	for (let index = 0; index < blockCount; ++index) {
		for (const successor of successors[index]!) {
			predecessors[successor]!.add(index);
		}
		for (const handler of handlerDependencies[index]!) {
			predecessors[handler]!.add(index);
		}
	}

	// Start in block order and pop from the end, preserving the useful reverse
	// layout bias. Thereafter only predecessors of a changed live-in are revisited.
	const worklist = fn.blocks.map((_, index) => index);
	const queued = fn.blocks.map(() => true);
	while (worklist.length > 0) {
		const index = worklist.pop()!;
		queued[index] = false;
		const liveOut = new Set<number>();
		for (const successor of successors[index]!) {
			for (const register of liveInByBlock[successor]!) {
				liveOut.add(register);
			}
		}
		const liveIn = transferBlock(fn, index, liveOut, liveInByBlock, handlerByInstruction);
		liveOutByBlock[index] = liveOut;
		if (setsEqual(liveIn, liveInByBlock[index]!)) {
			continue;
		}

		liveInByBlock[index] = liveIn;
		for (const predecessor of predecessors[index]!) {
			if (!queued[predecessor]) {
				queued[predecessor] = true;
				worklist.push(predecessor);
			}
		}
	}

	return { liveInByBlock, liveOutByBlock, handlerByInstruction };
}

function allRegisters(registerCount: number): Set<number> {
	const registers = new Set<number>();
	for (let register = 0; register < registerCount; ++register) {
		registers.add(register);
	}
	return registers;
}

function fallbackRequired(
	complexityEstimate: number | null,
	options: LivenessOptions,
): boolean {
	const limit = options.complexityLimit ?? DEFAULT_LIVENESS_COMPLEXITY_LIMIT;
	if (!Number.isFinite(limit) || limit < 0) {
		throw new Error(`Invalid liveness complexity limit ${limit}`);
	}
	return complexityEstimate === null || complexityEstimate > limit;
}

interface CollectedSafepoints {
	liveAcrossSafepoint: Set<number>;
	liveOrUsedAtSafepoint: Set<number>;
	safepoints: Array<Safepoint>;
}

function collectSafepoints(
	fn: IRFunction,
	solved: SolvedLiveness,
	detailed: boolean,
): CollectedSafepoints {
	// Re-walk each block backward, seeded by its live-out, to record every
	// safepoint and the registers live across it.
	const liveAcrossSafepoint = new Set<number>();
	const liveOrUsedAtSafepoint = new Set<number>();
	const safepoints: Array<Safepoint> = [];
	for (let index = 0; index < fn.blocks.length; ++index) {
		const live = new Set(solved.liveOutByBlock[index]);
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
				const across = detailed ? new Set<number>() : null;
				for (const register of live) {
					across?.add(register);
					liveAcrossSafepoint.add(register);
					liveOrUsedAtSafepoint.add(register);
				}
				const handler = solved.handlerByInstruction[index]![i];
				if (handler !== null && handler !== undefined) {
					for (const register of solved.liveInByBlock[handler]!) {
						across?.add(register);
						liveAcrossSafepoint.add(register);
						liveOrUsedAtSafepoint.add(register);
					}
				}
				// The safepoint's own operands are consumed by an operation that can
				// collect, so they must survive it even when dead immediately after
				// (`across`, being live-out, omits them). A loop-poll branch has no
				// such operand obligation, but its uses are harmless to include.
				for (const use of usedRegisters(instruction)) {
					liveOrUsedAtSafepoint.add(use);
				}
				if (across !== null) {
					safepoints.push({
						blockIndex: index,
						instructionIndex: i,
						// A back-edge can only be a jump/jumpIf, which never allocates, so
						// the two kinds are disjoint; alloc-call wins if both somehow held.
						kind: allocOrCall ? "alloc-call" : "loop-poll",
						live: across,
					});
				}
			}
			const def = definedRegister(instruction);
			if (def !== null) {
				live.delete(def);
			}
			const handler = solved.handlerByInstruction[index]![i];
			if (handler !== null && handler !== undefined) {
				for (const register of solved.liveInByBlock[handler]!) {
					live.add(register);
				}
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
	return { liveAcrossSafepoint, liveOrUsedAtSafepoint, safepoints };
}

/**
 * Aggregate-only production API. Unlike `computeFunctionLiveness`, this does
 * not allocate a Set for every safepoint.
 */
export function computeSafepointRoots(
	fn: IRFunction,
	options: LivenessOptions = {},
): SafepointRoots {
	const stats = analysisStats(fn);
	const complexityEstimate = complexityEstimateFor(fn, stats);
	if (fallbackRequired(complexityEstimate, options)) {
		return {
			registers: allRegisters(stats.registerCount),
			usedFallback: true,
			complexityEstimate,
		};
	}

	const solved = solveLiveness(fn);
	return {
		registers: collectSafepoints(fn, solved, false).liveOrUsedAtSafepoint,
		usedFallback: false,
		complexityEstimate,
	};
}

/** Live-variable analysis + back-edge identification for one IR function. */
export function computeFunctionLiveness(
	fn: IRFunction,
	options: LivenessOptions = {},
): FunctionLiveness {
	const stats = analysisStats(fn);
	const complexityEstimate = complexityEstimateFor(fn, stats);
	if (fallbackRequired(complexityEstimate, options)) {
		const registers = allRegisters(stats.registerCount);
		const { backEdges, headerBlocks } = findBackEdges(fn);
		return {
			liveInByBlock: fn.blocks.map(() => new Set<number>()),
			liveOutByBlock: fn.blocks.map(() => new Set<number>()),
			liveAcrossSafepoint: new Set(registers),
			liveOrUsedAtSafepoint: registers,
			safepoints: [],
			backEdges,
			headerBlocks,
			usedFallback: true,
			complexityEstimate,
		};
	}

	const solved = solveLiveness(fn);
	const { liveAcrossSafepoint, liveOrUsedAtSafepoint, safepoints } = collectSafepoints(
		fn,
		solved,
		true,
	);

	const { backEdges, headerBlocks } = findBackEdges(fn);
	return {
		liveInByBlock: solved.liveInByBlock,
		liveOutByBlock: solved.liveOutByBlock,
		liveAcrossSafepoint,
		liveOrUsedAtSafepoint,
		safepoints,
		backEdges,
		headerBlocks,
		usedFallback: false,
		complexityEstimate,
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
		output +=
			`  fallback: ${fl.usedFallback ? "all-registers" : "none"} ` +
			`(estimate=${fl.complexityEstimate ?? "overflow"})\n`;
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
