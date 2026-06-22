/**
 * Inliner eligibility analysis — foundation increment of the small-function inliner
 * (gc_todo.md task #6 / §N.7 step 4).
 *
 * Identifies direct `call` sites whose callee is a statically-known function (a
 * `createFunction` result) and whose target is safe + cheap to inline. This module
 * performs NO transformation, so it cannot miscompile; the substitution pass (next
 * increment) consumes these candidates and re-verifies before rewriting.
 *
 * Why inline: substituting a local closure's body into the caller lets DCE drop the
 * closure object + its captured `MalEnv` once the closure is otherwise unused — the
 * compiler-based answer to per-activation closure/env garbage that escape analysis
 * cannot reach (the HOF callee is dynamically dispatched). It also exposes cross-call
 * object flow for scalar replacement (T7.4).
 *
 * Conservative v1 target rules (the substitution re-checks): plain `call` only (not
 * construct/spread); callee resolvable to one known target that is not the caller
 * itself (direct self-recursion — deeper cycles are bounded by the substitution's
 * expansion depth); target is not a generator/async, materializes no `arguments`
 * object / rest parameter, owns no captured-slot env, contains no `this` /
 * `new.target` / `with` (caller-relative or dynamic-scope constructs), is free of
 * direct `eval` (C3, file-scoped), and is at most `MAX_INLINE_INSTRUCTIONS` real
 * instructions.
 */

import { addInlineSourcePosition } from "./ir.ts";
import type { IntermediateProgram, IRBlock, IRFunction, IRInstruction } from "./ir.ts";
import { definedRegister } from "./register-alloc.ts";
import { log } from "./utils.ts";

/** Max body size (real, non-marker instructions) of an inline target. */
const MAX_INLINE_INSTRUCTIONS = 40;

/**
 * Instruction kinds that make a function unsafe to inline as-is: `this` /
 * `new.target` are caller-relative (the callee's binding differs from the caller's),
 * an `arguments` object / rest parameter reflects the callee's own activation, and
 * `with` introduces dynamic scope. (`loadCaptured`/`storeCaptured` are fine: they
 * walk the env chain by owner function index, which a local closure inlined into its
 * definer resolves identically.)
 */
function disqualifies(instruction: IRInstruction): boolean {
	switch (instruction.type) {
		case "loadThis":
		case "loadNewTarget":
		case "createArgumentsObject":
		case "createRestArguments":
		case "withEnter":
		case "withExit":
		case "withGet":
		case "withSet":
			return true;
		default:
			return false;
	}
}

/** Whether a function's body is safe + small enough to inline. */
export function isInlinableTarget(fn: IRFunction): boolean {
	if (fn.isGenerator || fn.isAsync) {
		return false; // suspendable: not a straight-line body
	}
	if (fn.argumentsObjectRegister !== undefined) {
		return false; // materializes its own `arguments`
	}
	if ((fn.nextCapturedIndex ?? 0) > 0) {
		return false; // owns a captured-slot env (inner closures capture from it)
	}
	if (fn.semanticFile.hasDirectEval.size > 0) {
		return false; // C3: direct eval can observe locals (file-scoped, conservative)
	}
	let count = 0;
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			if (instruction.type === "sourcePos") {
				continue;
			}
			if (disqualifies(instruction)) {
				return false;
			}
			count++;
		}
	}
	return count > 0 && count <= MAX_INLINE_INSTRUCTIONS;
}

/** A captured slot identity: owner function index + slot index, as `owner:index`. */
function capturedSlotKey(owner: number, index: number): string {
	return `${owner}:${index}`;
}

/**
 * Per-function map: register → the functionIndex it provably holds. A register holds
 * a known function when its sole definition is a `createFunction`, a single-assignment
 * `move` chain from one (`const f = () => …`), or a `loadCaptured` of a captured slot
 * that `capturedSlots` proves holds one (function declarations + captured local
 * closures bind through the captured env). Used to resolve a call's callee.
 */
function functionValuedRegisters(
	fn: IRFunction,
	capturedSlots: ReadonlyMap<string, number>,
): Map<number, number> {
	const defCount = new Map<number, number>();
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			if (!("registers" in instruction)) {
				continue;
			}
			const def = definedRegister(instruction);
			if (def !== null) {
				defCount.set(def, (defCount.get(def) ?? 0) + 1);
			}
		}
	}

	const funcOf = new Map<number, number>();
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			if (
				instruction.type === "createFunction" &&
				defCount.get(instruction.registers[0]) === 1
			) {
				funcOf.set(instruction.registers[0], instruction.functionIndex);
			}
		}
	}

	// Propagate through single-assignment moves + resolved captured-slot loads, to a
	// fixpoint (a move may chain off a loadCaptured and vice versa).
	let changed = true;
	while (changed) {
		changed = false;
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				if (instruction.type === "move") {
					const destination = instruction.registers[0];
					const source = instruction.registers[1];
					if (
						defCount.get(destination) === 1 &&
						funcOf.has(source) &&
						!funcOf.has(destination)
					) {
						funcOf.set(destination, funcOf.get(source)!);
						changed = true;
					}
				} else if (
					instruction.type === "loadCaptured" &&
					instruction.functionIndex !== undefined &&
					instruction.index !== undefined
				) {
					const destination = instruction.registers[0];
					const slot = capturedSlots.get(
						capturedSlotKey(instruction.functionIndex, instruction.index),
					);
					if (
						slot !== undefined &&
						defCount.get(destination) === 1 &&
						!funcOf.has(destination)
					) {
						funcOf.set(destination, slot);
						changed = true;
					}
				}
			}
		}
	}
	return funcOf;
}

/**
 * Program-wide: captured slots that provably hold a single known function — written
 * exactly once (across all functions), by a `createFunction`/move value. A slot
 * written more than once, or from a non-function, is excluded. (Resolving the store
 * source uses only createFunction+move, no captured loads, to avoid circularity.)
 */
function capturedSlotFunctions(program: IntermediateProgram): Map<string, number> {
	const empty = new Map<string, number>();
	const stores = new Map<string, { func: number | undefined; count: number }>();
	for (const fn of program.functions) {
		const localFuncOf = functionValuedRegisters(fn, empty);
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				if (
					instruction.type !== "storeCaptured" ||
					instruction.functionIndex === undefined ||
					instruction.index === undefined
				) {
					continue;
				}
				const key = capturedSlotKey(instruction.functionIndex, instruction.index);
				const func = localFuncOf.get(instruction.registers[0]);
				const existing = stores.get(key);
				if (existing === undefined) {
					stores.set(key, { func, count: 1 });
				} else {
					existing.count += 1;
				}
			}
		}
	}
	const resolved = new Map<string, number>();
	for (const [key, { func, count }] of stores) {
		if (count === 1 && func !== undefined) {
			resolved.set(key, func);
		}
	}
	return resolved;
}

export interface InlineCandidate {
	/** The `call` instruction in the caller. */
	call: IRInstruction;
	/** functionIndex of the resolved, eligible target. */
	target: number;
}

export interface ProgramInlineCandidates {
	/** Keyed by caller `IRFunction.functionIndex`. */
	byCaller: Map<number, Array<InlineCandidate>>;
}

/** Find direct `call` sites across the program whose callee is a statically-known,
 * inlinable function. */
export function findInlinableCalls(
	program: IntermediateProgram,
): ProgramInlineCandidates {
	const eligibleCache = new Map<number, boolean>();
	const isEligible = (index: number): boolean => {
		const cached = eligibleCache.get(index);
		if (cached !== undefined) {
			return cached;
		}
		const target = program.functions.find((fn) => fn.functionIndex === index);
		const ok = target !== undefined && isInlinableTarget(target);
		eligibleCache.set(index, ok);
		return ok;
	};

	const capturedSlots = capturedSlotFunctions(program);
	const byCaller = new Map<number, Array<InlineCandidate>>();
	for (const fn of program.functions) {
		const funcOf = functionValuedRegisters(fn, capturedSlots);
		const candidates: Array<InlineCandidate> = [];
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				if (instruction.type !== "call") {
					continue;
				}
				const calleeRegister = instruction.registers[1];
				const target = funcOf.get(calleeRegister);
				if (target === undefined || target === fn.functionIndex || !isEligible(target)) {
					continue; // unknown callee / direct self-recursion / ineligible target
				}
				candidates.push({ call: instruction, target });
			}
		}
		if (candidates.length > 0) {
			byCaller.set(fn.functionIndex, candidates);
		}
	}
	return { byCaller };
}

// ---------------------------------------------------------------------------
// Substitution (transformation). Two shapes: a straight-line single-`return`
// target is spliced in place (no control-flow surgery); a branching/multi-`return`
// target is spliced block-wise (host split + appended blocks + return-join). Both
// rely on the IR invariant that every block ends in an explicit jump/return/throw
// (no positional fall-through), so appended blocks need no fall-through fix-up.
// Inlined source positions are rewrapped into inline-frame markers for stack traces.
// ---------------------------------------------------------------------------

/** Cap on a caller's instruction count to bound inline expansion (mutual recursion
 * etc. inlines a few levels then stops). */
const MAX_CALLER_INSTRUCTIONS = 2000;

/**
 * If `fn` is a single straight-line block ending in `return` (no branches, no
 * other terminators, no try/closure constructs), return that block — the only
 * shape v1 substitutes. Returns null otherwise.
 */
function singleReturnBlock(fn: IRFunction): IRBlock | null {
	if (fn.blocks.length !== 1) {
		return null;
	}
	const block = fn.blocks[0]!;
	const instructions = block.instructions;
	const last = instructions[instructions.length - 1];
	if (last === undefined || last.type !== "return") {
		return null;
	}
	for (let i = 0; i < instructions.length - 1; ++i) {
		switch (instructions[i]!.type) {
			case "return":
			case "throw":
			case "jump":
			case "jumpIf":
			case "tryBegin":
			case "tryEnd":
			case "createFunction": // inner closure: creation_env subtleties — defer
				return null;
		}
	}
	return block;
}

const MULTI_BLOCK_TERMINATORS = new Set(["jump", "return", "throw"]);

/**
 * Whether a target with branches/multiple returns is safe to splice block-wise.
 * The body *shape* (no `this`/`arguments`/`with`/eval/captured env, size-bounded)
 * is already vetted by `isInlinableTarget`; here we additionally require
 * inline-able *control flow*: branch targets are `jump`/`jumpIf` (remappable by a
 * constant block offset) and every block ends in an unconditional terminator —
 * the IR's invariant (no positional fall-through), which lets us append the
 * target's blocks + a join block with no fall-through fix-up. Reject `try`/`catch`
 * (handler-table merge — deferred) and inner closures (`createFunction`
 * creation-env remapping — deferred). Returns the blocks to splice, or null.
 */
function multiBlockInlinable(fn: IRFunction): ReadonlyArray<IRBlock> | null {
	for (const block of fn.blocks) {
		const last = block.instructions[block.instructions.length - 1];
		if (last === undefined || !MULTI_BLOCK_TERMINATORS.has(last.type)) {
			return null; // empty block, or relies on positional fall-through
		}
		for (const instruction of block.instructions) {
			switch (instruction.type) {
				case "tryBegin":
				case "tryEnd":
				case "catch":
				case "createFunction":
					return null;
			}
		}
	}
	return fn.blocks;
}

/**
 * Whether the call at `host[index]` sits inside a try-protected region. Exception
 * handler ranges are `[tryBegin_ip, tryEnd_ip)` over the *flattened* instruction
 * stream (block-array order, see lower-vm `collectExceptionHandlers`). Multi-block
 * inlining appends the spliced blocks after every original block — hence after
 * every `tryEnd` marker — so a relocated throw (explicit, or from any throwing
 * inlined op) would escape the enclosing handler. We therefore refuse to multi-
 * block-inline a protected call. (Single-block inlining splices in place, staying
 * within the range, so it is unaffected.)
 */
function isCallInTry(fn: IRFunction, host: IRBlock, index: number): boolean {
	let depth = 0;
	for (const block of fn.blocks) {
		for (let i = 0; i < block.instructions.length; ++i) {
			if (block === host && i === index) {
				return depth > 0;
			}
			const type = block.instructions[i]!.type;
			if (type === "tryBegin") {
				depth++;
			} else if (type === "tryEnd") {
				depth--;
			}
		}
	}
	return false; // call not found (shouldn't happen): treat as unprotected
}

/** Clone an instruction with every register operand shifted by `offset` (negative
 * sentinels are left as-is). Non-register fields (functionIndex, index, stringIndex,
 * value, blocks, …) are preserved — in particular `loadCaptured`/`storeCaptured`
 * keep their owner/slot, so captured access resolves identically once the closure's
 * body runs against its definer's env. */
function withRegisterOffset(instruction: IRInstruction, offset: number): IRInstruction {
	if (!("registers" in instruction)) {
		return { ...instruction };
	}
	const registers = (instruction.registers as ReadonlyArray<number>).map((r) =>
		r >= 0 ? r + offset : r,
	);
	return { ...instruction, registers } as IRInstruction;
}

/**
 * Rewrap an inlined instruction's source position so it reads as the inlined
 * function's frame, called at `callerPosId`. Recurses through an existing inline
 * chain (nested inlining), replacing the terminal leaf — the inlined function's own
 * position — with the call-site link, so the formatter expands one frame per level.
 */
function wrapInlinePosition(
	program: IntermediateProgram,
	posId: number,
	inlinedFunctionIndex: number,
	callerPosId: number,
): number {
	if (posId < 0) {
		return callerPosId; // no position: inlined code inherits the call-site frame
	}
	const pos = program.sourcePositions[posId]!;
	if (pos.inlinedFunctionIndex === undefined) {
		return addInlineSourcePosition(
			program,
			pos.line,
			pos.column,
			inlinedFunctionIndex,
			callerPosId,
		);
	}
	const extended = wrapInlinePosition(
		program,
		pos.callerPosId!,
		inlinedFunctionIndex,
		callerPosId,
	);
	return addInlineSourcePosition(
		program,
		pos.line,
		pos.column,
		pos.inlinedFunctionIndex,
		extended,
	);
}

/** Total real (non-marker) instruction count of a function. */
function instructionCount(fn: IRFunction): number {
	let count = 0;
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			if (instruction.type !== "sourcePos") {
				count += 1;
			}
		}
	}
	return count;
}

/**
 * Inline direct calls. For each inlinable call to a target T, shift T's registers
 * above the caller's and move the call's arguments into T's parameter registers
 * (missing args → undefined). A straight-line single-`return` T is spliced in place
 * of the call (its returned register moved into the destination). A branching/
 * multi-`return` T is spliced block-wise: the host block is split at the call, T's
 * blocks + a join block are appended (branch targets remapped by a constant block
 * offset), and every `return` becomes move-to-dst + jump-to-join. T's captured-slot
 * loads/stores need no remapping (they walk the env chain by owner index, which a
 * local closure inlined into its definer resolves the same way). When the inlined
 * closure is afterwards unused, DCE drops its `createFunction` → no closure object +
 * no captured `MalEnv` allocated.
 */
export function optInlineCalls(program: IntermediateProgram): boolean {
	let changed = false;
	const { byCaller } = findInlinableCalls(program);
	const targetOf = new Map<number, IRFunction>();
	for (const fn of program.functions) {
		targetOf.set(fn.functionIndex, fn);
	}

	for (const fn of program.functions) {
		const candidates = byCaller.get(fn.functionIndex);
		if (candidates === undefined) {
			continue;
		}
		for (const { call, target } of candidates) {
			if (instructionCount(fn) >= MAX_CALLER_INSTRUCTIONS) {
				break; // expansion guard
			}
			const targetFn = targetOf.get(target);
			if (targetFn === undefined) {
				continue;
			}
			const singleBlock = singleReturnBlock(targetFn);
			const multiBlocks = singleBlock === null ? multiBlockInlinable(targetFn) : null;
			if (singleBlock === null && multiBlocks === null) {
				continue; // not an inlinable shape (yet)
			}

			// Locate the call by reference (earlier inlines shift indices/blocks).
			let host: IRBlock | undefined;
			let index = -1;
			for (const candidateBlock of fn.blocks) {
				const at = candidateBlock.instructions.indexOf(call);
				if (at >= 0) {
					host = candidateBlock;
					index = at;
					break;
				}
			}
			if (host === undefined) {
				continue; // already removed/rewritten by a prior step
			}

			if (singleBlock === null && isCallInTry(fn, host, index)) {
				continue; // multi-block relocation would move code out of the enclosing try
			}

			// call.registers = [destination, callee, this, ...arguments]
			const callRegisters = (call as { registers: ReadonlyArray<number> }).registers;
			const destination = callRegisters[0]!;
			const args = callRegisters.slice(3);

			// The source position active at the call (nearest preceding marker in the
			// host block) roots the inlined frames in the caller.
			let callSitePos = -1;
			for (let i = index - 1; i >= 0; --i) {
				const prior = host.instructions[i]!;
				if (prior.type === "sourcePos") {
					callSitePos = prior.pos;
					break;
				}
			}

			const offset = fn.nextRegisterDestination;
			fn.nextRegisterDestination += targetFn.nextRegisterDestination;

			// Parameter binding (shared): args → param registers (offset), missing →
			// undefined. The target's params occupy its first `parameterCount` registers.
			const paramSetup: Array<IRInstruction> = [];
			for (let i = 0; i < targetFn.parameterCount; ++i) {
				const paramRegister = offset + i;
				paramSetup.push(
					i < args.length
						? { type: "move", registers: [paramRegister, args[i]!] }
						: { type: "createUndefined", registers: [paramRegister] },
				);
			}

			// Rewrap an inlined source position so traces show the target's frame
			// called at the call site (inline-frame markers).
			const rewrap = (
				instruction: Extract<IRInstruction, { type: "sourcePos" }>,
			): IRInstruction => ({
				type: "sourcePos",
				pos: wrapInlinePosition(program, instruction.pos, target, callSitePos),
			});

			if (singleBlock !== null) {
				// Straight-line target: splice its body (minus the trailing `return`) in
				// place of the call, moving the returned register into the destination.
				const inlined: Array<IRInstruction> = [...paramSetup];
				const body = singleBlock.instructions;
				for (let i = 0; i < body.length - 1; ++i) {
					const instruction = body[i]!;
					inlined.push(
						instruction.type === "sourcePos"
							? rewrap(instruction)
							: withRegisterOffset(instruction, offset),
					);
				}
				const returnInstruction = body[body.length - 1] as {
					registers: ReadonlyArray<number>;
				};
				const returnRegister = returnInstruction.registers[0]!;
				if (destination >= 0) {
					inlined.push({
						type: "move",
						registers: [destination, offset + returnRegister],
					});
				}
				host.instructions.splice(index, 1, ...inlined);
				changed = true;
				continue;
			}

			// Multi-block target: split the host block at the call, append the target's
			// blocks (offset registers, branch targets by +base) and a join block, and
			// convert every `return` to move-to-dst + jump-to-join. Block order is
			// irrelevant (all edges are explicit), so appending at the end is sound and
			// touches no existing block index.
			const blocks = multiBlocks!;
			const base = fn.blocks.length;
			const joinIndex = base + blocks.length;
			const post = host.instructions.slice(index + 1);
			if (post.length === 0) {
				continue; // call at block end (no terminator follows) — shouldn't happen
			}
			// Host: pre + param binding + jump to the inlined entry (the target's block 0).
			host.instructions = [
				...host.instructions.slice(0, index),
				...paramSetup,
				{ type: "jump", blocks: [base] },
			];

			for (const tblock of blocks) {
				const out: Array<IRInstruction> = [];
				for (const instruction of tblock.instructions) {
					if (instruction.type === "sourcePos") {
						out.push(rewrap(instruction));
						continue;
					}
					if (instruction.type === "return") {
						const returnRegister = instruction.registers[0]!;
						if (destination >= 0) {
							out.push({
								type: "move",
								registers: [
									destination,
									returnRegister >= 0 ? returnRegister + offset : returnRegister,
								],
							});
						}
						out.push({ type: "jump", blocks: [joinIndex] });
						break; // terminator: the rest of this block is dead
					}
					if (instruction.type === "throw") {
						out.push(withRegisterOffset(instruction, offset));
						break;
					}
					if (instruction.type === "jump") {
						out.push({ type: "jump", blocks: [instruction.blocks[0] + base] });
						break;
					}
					if (instruction.type === "jumpIf") {
						const condition = instruction.registers[0]!;
						out.push({
							type: "jumpIf",
							registers: [condition >= 0 ? condition + offset : condition],
							blocks: [instruction.blocks[0] + base],
						});
						continue;
					}
					out.push(withRegisterOffset(instruction, offset));
				}
				fn.blocks.push({ instructions: out });
			}
			// Join: the host's tail after the call (already ends in the host's terminator).
			fn.blocks.push({ instructions: post });
			changed = true;
		}
	}
	return changed;
}

// ---------------------------------------------------------------------------
// Captured-slot internalization (env elimination). After inlining pulls a
// capturing closure's body into its definer, the body reads the captured variable
// via `loadCaptured(definer, idx)` — so the definer still allocates a `MalEnv`. When
// a slot is written exactly once from a stable register and ALL its accesses are now
// inside the definer, the loads can read that register directly and the store drop;
// once no captured access of a function remains, its env allocation is removed.
// ---------------------------------------------------------------------------

/**
 * Empty the body of every function unreachable from the entry via `createFunction`
 * edges. A function whose closure is never created can never run, so its body is
 * dead — after inlining + DCE removes a closure's `createFunction`, its original body
 * becomes unreachable. Emptying it reclaims code size AND unblocks env elimination
 * (the only remaining accesses of the definer's captured slots are then the inlined
 * ones, all inside the definer).
 *
 * Sound: `createFunction` is the only IR op that references a function as a value
 * (`loadCaptured`/`storeCaptured`'s functionIndex is a scope id within the function's
 * own — now dead — body). The entry (index 0) is always live. `functionIndex` ==
 * array position is preserved: functions are stubbed in place, never removed.
 */
export function optEmptyDeadFunctions(program: IntermediateProgram): boolean {
	const byIndex = new Map<number, IRFunction>();
	for (const fn of program.functions) {
		byIndex.set(fn.functionIndex, fn);
	}

	const live = new Set<number>([0]);
	const worklist = [0];
	while (worklist.length > 0) {
		const fn = byIndex.get(worklist.pop()!);
		if (fn === undefined) {
			continue;
		}
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				if (
					instruction.type === "createFunction" &&
					!live.has(instruction.functionIndex)
				) {
					live.add(instruction.functionIndex);
					worklist.push(instruction.functionIndex);
				}
			}
		}
	}

	let changed = false;
	for (const fn of program.functions) {
		if (live.has(fn.functionIndex)) {
			continue;
		}
		const onlyBlock = fn.blocks.length === 1 ? fn.blocks[0]! : undefined;
		const alreadyStub =
			onlyBlock !== undefined &&
			onlyBlock.instructions.length === 2 &&
			onlyBlock.instructions[0]!.type === "createUndefined";
		if (alreadyStub) {
			continue;
		}
		fn.blocks = [
			{
				instructions: [
					{ type: "createUndefined", registers: [0] },
					{ type: "return", registers: [0] },
				],
			},
		];
		fn.parameterCount = 0;
		fn.nextRegisterDestination = 1;
		fn.nextCapturedIndex = 0;
		fn.argumentsObjectRegister = undefined;
		fn.isGenerator = false;
		fn.isAsync = false;
		changed = true;
	}
	return changed;
}

interface CapturedSlotUse {
	fn: IRFunction;
	instruction: IRInstruction;
}

/**
 * Replace captured slots that are provably internal to their owner with direct
 * register access, then drop the env of any function left with no captured access.
 * Conservative: a slot is internalized only when every load/store of it is in the
 * owner function, there is exactly one store, and its source register is
 * single-assignment (a stable value at every read).
 */
export function optEliminateCapturedSlots(program: IntermediateProgram): boolean {
	// Gather, per (owner, idx), every load and store across the whole program, plus
	// each function's single-definition register set.
	const loadsBySlot = new Map<string, Array<CapturedSlotUse>>();
	const storesBySlot = new Map<string, Array<{ use: CapturedSlotUse; source: number }>>();
	const defCountByFn = new Map<number, Map<number, number>>();
	const slotOwners = new Set<string>();

	for (const fn of program.functions) {
		const defCount = new Map<number, number>();
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				if ("registers" in instruction) {
					const def = definedRegister(instruction);
					if (def !== null) {
						defCount.set(def, (defCount.get(def) ?? 0) + 1);
					}
				}
			}
		}
		defCountByFn.set(fn.functionIndex, defCount);

		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				if (
					(instruction.type === "loadCaptured" || instruction.type === "storeCaptured") &&
					instruction.functionIndex !== undefined &&
					instruction.index !== undefined
				) {
					const key = capturedSlotKey(instruction.functionIndex, instruction.index);
					slotOwners.add(`${instruction.functionIndex}`);
					if (instruction.type === "loadCaptured") {
						(loadsBySlot.get(key) ?? loadsBySlot.set(key, []).get(key)!).push({
							fn,
							instruction,
						});
					} else {
						(storesBySlot.get(key) ?? storesBySlot.set(key, []).get(key)!).push({
							use: { fn, instruction },
							source: instruction.registers[0]!,
						});
					}
				}
			}
		}
	}

	// Rewrite the loads of each internalizable slot to read the stored register, and
	// mark the slot's store for removal. Track which (owner) functions had a slot
	// internalized so we can re-check their env afterwards.
	const dropStore = new Set<IRInstruction>();
	let changed = false;
	for (const [key, stores] of storesBySlot) {
		if (stores.length !== 1) {
			continue; // mutated (or never read with a single store): leave it
		}
		const ownerIndex = Number(key.split(":")[0]);
		const store = stores[0]!;
		const loads = loadsBySlot.get(key) ?? [];
		// Every access must be in the owner function.
		if (
			store.use.fn.functionIndex !== ownerIndex ||
			loads.some((l) => l.fn.functionIndex !== ownerIndex)
		) {
			continue;
		}
		// The stored source must be single-assignment (stable at every read).
		if ((defCountByFn.get(ownerIndex)?.get(store.source) ?? 0) > 1) {
			continue;
		}
		for (const load of loads) {
			const mutable = load.instruction as {
				type: string;
				registers: Array<number>;
				functionIndex?: number;
				index?: number;
			};
			mutable.type = "move";
			mutable.registers = [mutable.registers[0]!, store.source];
			delete mutable.functionIndex;
			delete mutable.index;
		}
		dropStore.add(store.use.instruction);
		changed = true;
	}

	if (dropStore.size > 0) {
		for (const fn of program.functions) {
			for (const block of fn.blocks) {
				if (block.instructions.some((instruction) => dropStore.has(instruction))) {
					block.instructions = block.instructions.filter(
						(instruction) => !dropStore.has(instruction),
					);
				}
			}
		}
	}

	// Any function with no remaining captured access of its own slots needs no env.
	for (const fn of program.functions) {
		if ((fn.nextCapturedIndex ?? 0) === 0) {
			continue;
		}
		let usesOwnEnv = false;
		for (const otherFn of program.functions) {
			for (const block of otherFn.blocks) {
				for (const instruction of block.instructions) {
					if (
						(instruction.type === "loadCaptured" ||
							instruction.type === "storeCaptured") &&
						instruction.functionIndex === fn.functionIndex
					) {
						usesOwnEnv = true;
					}
				}
			}
		}
		if (!usesOwnEnv) {
			fn.nextCapturedIndex = 0; // no env allocation needed
			changed = true;
		}
	}

	return changed;
}

/** Render the inlinable-call summary for `--dump-inline`. */
export function debugInlinableCalls(program: IntermediateProgram): string {
	const { byCaller } = findInlinableCalls(program);
	let output = "";
	for (const fn of program.functions) {
		const candidates = byCaller.get(fn.functionIndex);
		if (candidates === undefined || candidates.length === 0) {
			continue;
		}
		output += `fn#${fn.functionIndex}: ${candidates.length} inlinable call(s) → ${candidates
			.map((candidate) => `#${candidate.target}`)
			.join(", ")}\n`;
	}
	log.info(output || "(no inlinable calls)\n");
	return output;
}
