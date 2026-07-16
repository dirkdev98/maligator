import {
	decodeStringConstant,
	optEliminateCapturedSlots,
	optEmptyDeadFunctions,
	optInlineCalls,
	optInlineHofCallbacks,
	optInlineMethod,
	optInlineSpeculative,
} from "./inline.ts";
import { debugIntermediateProgram } from "./ir.ts";
import type { IntermediateProgram, IRFunction, IRInstruction } from "./ir.ts";
import { debugEnabled, isNil } from "./utils.ts";

/**
 * IR instruction kinds with no side effects beyond writing their destination
 * register: they read operands and globals/slots, never run user code, never
 * throw, and never mutate observable state. One whose destination is never read
 * is dead and can be dropped. Deliberately conservative — `binary`/`unary` can
 * run a `valueOf`/`toString` or throw, property/call/store ops have effects, so
 * none of those appear here.
 */
const SIDE_EFFECT_FREE_OPS = new Set<IRInstruction["type"]>([
	"createNumber",
	"createF64",
	"createBoolean",
	"createString",
	"createBigint",
	"createUndefined",
	"createNull",
	"createEmpty",
	// Allocates a closure object but has no other observable effect, so an unused
	// one (e.g. a closure all of whose calls were inlined) is dead and removable —
	// this is what lets inlining eliminate the closure allocation. Capturing
	// declarations keep it alive through their storeCaptured (a non-listed effect).
	"createFunction",
	"move",
	"loadLocal",
	"loadGlobal",
	"loadCaptured",
	"loadIntrinsic",
	"loadThis",
	"loadNewTarget",
]);

/** Execute the ordered IR optimization pipeline. */
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
		optCopyPropagation,
		// Fold only primitive operations whose exact JavaScript result can be
		// computed without coercing an object or running user code. Constant jump
		// cleanup then exposes dead blocks to the existing CFG passes.
		optFoldPrimitiveConstants,
		// Rewrite `arr.forEach(cb)` into a guarded inlined loop whose `cb(...)` is a
		// direct call. Runs before optInlineCalls so that direct call is folded in the
		// same fixpoint round → the per-call closure + its captured env are eliminated.
		optInlineHofCallbacks,
		// Runs after copy propagation so a call's callee resolves to its function
		// value through the move chain; before scalar replacement (inlining exposes
		// cross-call object flow) and DCE (which drops the now-unused closure's
		// createFunction → no closure/env allocation).
		optInlineCalls,
		// Speculative (guarded) inlining of reassignable-global direct calls (script-mode
		// top-level functions). Runs after the static inliner so only genuinely-dynamic
		// callees reach it; its deopt path is a normal call, folded no further.
		optInlineSpeculative,
		// Shape-guarded method inlining: `obj.m()` where m uniquely resolves to a known
		// candidate; guarded by the resolved callee's function index (the loadProperty callee
		// is already the proto-resolved method), inlined with this = receiver. Deopt = call.
		optInlineMethod,
		// Runs after copy propagation so a record's reads reference its allocation
		// register directly (not a local copy), and before DCE so the freed key
		// constants and unread values are cleaned up the same round.
		optScalarReplaceObjectLiterals,
		// The mutable generalization: a non-escaping object that IS written
		// (storeProperty) becomes per-key registers (T7.4). Handled separately from
		// the immutable pass above, which only fires on never-written records.
		optScalarReplaceMutableObjects,
		// Empty functions made unreachable by inlining (their createFunction was
		// DCE'd) — reclaims dead bodies and unblocks env elimination below.
		optEmptyDeadFunctions,
		// After inlining consolidates a closure's captured reads into its definer,
		// internalize single-store immutable slots to direct register access and drop
		// the now-unused env — completing closure+env elimination for capturing
		// closures. Before DCE so the dropped stores / freed closures are cleaned up.
		optEliminateCapturedSlots,
		optDeadInstructionElimination,
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

	// This is intentionally outside the transform fixpoint: it classifies the
	// residual identity-observed objects left after scalar replacement, and keys
	// the proof to the exact allocation instruction before register reuse.
	annotateStackObjectSites(program);
	optStaticPropertyKeys(program);
	optDeadInstructionElimination(program);

	if (debugEnabled) debugIntermediateProgram(program);
}

/**
 * Fold constant-string property keys into dedicated operations after all passes
 * that reason about the generic load/store shape have finished. DCE then removes
 * key-producing createString instructions that have no other consumers.
 */
function optStaticPropertyKeys(program: IntermediateProgram): boolean {
	let changed = false;
	for (const fn of program.functions) {
		const definitions = new Map<number, IRInstruction>();
		const duplicateDefinitions = new Set<number>();
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				if (!("registers" in instruction)) continue;
				const count = destinationCount(instruction);
				for (let i = 0; i < count; i++) {
					const register = instruction.registers[i]!;
					if (definitions.has(register)) duplicateDefinitions.add(register);
					else definitions.set(register, instruction);
				}
			}
		}

		for (const block of fn.blocks) {
			for (let i = 0; i < block.instructions.length; i++) {
				const instruction = block.instructions[i]!;
				if (instruction.type !== "loadProperty" && instruction.type !== "storeProperty") {
					continue;
				}
				const keyPosition = instruction.type === "loadProperty" ? 2 : 1;
				const keyRegister = instruction.registers[keyPosition];
				if (duplicateDefinitions.has(keyRegister)) continue;
				const key = definitions.get(keyRegister);
				if (key?.type !== "createString") continue;
				block.instructions[i] =
					instruction.type === "loadProperty"
						? {
								type: "loadPropertyStatic",
								registers: [instruction.registers[0], instruction.registers[1]],
								stringIndex: key.stringIndex,
							}
						: {
								type: "storePropertyStatic",
								registers: [instruction.registers[0], instruction.registers[2]],
								stringIndex: key.stringIndex,
							};
				changed = true;
			}
		}
	}
	return changed;
}

/**
 * Prove the first native stack-object class: a closed, fixed-shape ordinary
 * object whose identity/type/prototype may be observed, but whose pointer cannot
 * leave the activation or enter any operation capable of retaining it.
 *
 * This deliberately does not consume `stackAllocCandidates` from escape.ts. A
 * use not listed below rejects the site, including every call position, return,
 * throw, capture/global/heap store, dynamic or missing-key read, shape mutation,
 * enumeration, delete, and suspension-related operation.
 */
export function annotateStackObjectSites(program: IntermediateProgram): void {
	for (const fn of program.functions) {
		// Slots stay rooted for the full activation. Bound their aggregate C-stack
		// and root-scan cost; later sites simply retain ordinary heap allocation.
		const maxStackObjectSlots = 256;
		let stackObjectSlots = 0;
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				if (
					instruction.type === "createObject" ||
					instruction.type === "createObjectShaped"
				) {
					delete instruction.stackObject;
				}
			}
		}

		if (
			fn.isGenerator ||
			fn.isAsync ||
			fn.semanticFile.hasDirectEval.size > 0 ||
			functionUsesWith(fn)
		) {
			continue;
		}

		const defCount = new Map<number, number>();
		const singleDef = new Map<number, IRInstruction>();
		const usesOf = new Map<
			number,
			Array<{ instruction: IRInstruction; position: number }>
		>();
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				if (!("registers" in instruction)) continue;
				const defs = destinationCount(instruction);
				for (let position = 0; position < defs; position++) {
					const register = instruction.registers[position]!;
					if (register < 0) continue;
					const count = (defCount.get(register) ?? 0) + 1;
					defCount.set(register, count);
					if (count === 1) singleDef.set(register, instruction);
					else singleDef.delete(register);
				}
				for (let position = defs; position < instruction.registers.length; position++) {
					const register = instruction.registers[position]!;
					if (register < 0) continue;
					const uses = usesOf.get(register) ?? [];
					uses.push({ instruction, position });
					usesOf.set(register, uses);
				}
			}
		}

		const constantString = (register: number): number | undefined => {
			const definition = singleDef.get(register);
			return definition?.type === "createString" ? definition.stringIndex : undefined;
		};

		for (const block of fn.blocks) {
			for (const allocation of block.instructions) {
				if (
					allocation.type !== "createObject" &&
					allocation.type !== "createObjectShaped"
				) {
					continue;
				}
				const objectRegister = allocation.registers[0];
				if (
					defCount.get(objectRegister) !== 1 ||
					singleDef.get(objectRegister) !== allocation
				) {
					continue;
				}

				const keyStringIndices =
					allocation.type === "createObjectShaped" ? allocation.keyStringIndices : [];
				const ownKeys = new Set(keyStringIndices);
				const aliases = new Set<number>([objectRegister]);
				const worklist = [objectRegister];
				let observed = false;
				let safe = true;
				while (safe && worklist.length > 0) {
					const alias = worklist.pop()!;
					for (const { instruction: use, position } of usesOf.get(alias) ?? []) {
						switch (use.type) {
							case "move": {
								const target = use.registers[0];
								if (
									position !== 1 ||
									defCount.get(target) !== 1 ||
									singleDef.get(target) !== use
								) {
									safe = false;
									break;
								}
								if (!aliases.has(target)) {
									aliases.add(target);
									worklist.push(target);
								}
								break;
							}
							case "loadProperty": {
								const key = constantString(use.registers[2]);
								if (position !== 1 || key === undefined || !ownKeys.has(key)) {
									safe = false;
								}
								break;
							}
							case "storeProperty": {
								const key = constantString(use.registers[1]);
								if (position !== 0 || key === undefined || !ownKeys.has(key)) {
									safe = false;
								}
								break;
							}
							case "loadPrototype":
								if (position !== 1) safe = false;
								else observed = true;
								break;
							case "unary":
								if (position !== 1 || use.operator !== "typeof") safe = false;
								else observed = true;
								break;
							case "binary":
								if (
									(position !== 1 && position !== 2) ||
									(use.operator !== "===" && use.operator !== "!==")
								) {
									safe = false;
								} else {
									observed = true;
								}
								break;
							default:
								safe = false;
						}
						if (!safe) break;
					}
				}

				// Pure load/store records belong to scalar replacement. Requiring a real
				// identity/type/prototype observation keeps this as the residual class.
				if (
					safe &&
					observed &&
					stackObjectSlots + keyStringIndices.length <= maxStackObjectSlots
				) {
					allocation.stackObject = true;
					stackObjectSlots += keyStringIndices.length;
				}
			}
		}
	}
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

type FoldedPrimitive =
	| { kind: "number"; value: number }
	| { kind: "boolean"; value: boolean }
	| { kind: "null" }
	| { kind: "undefined" };

function foldedPrimitive(
	instruction: IRInstruction | undefined,
): FoldedPrimitive | undefined {
	switch (instruction?.type) {
		case "createNumber":
		case "createF64":
			return { kind: "number", value: instruction.value };
		case "createBoolean":
			return { kind: "boolean", value: instruction.value };
		case "createNull":
			return { kind: "null" };
		case "createUndefined":
			return { kind: "undefined" };
		default:
			return undefined;
	}
}

function primitiveTruthy(value: FoldedPrimitive): boolean {
	switch (value.kind) {
		case "number":
			return value.value !== 0 && !Number.isNaN(value.value);
		case "boolean":
			return value.value;
		case "null":
		case "undefined":
			return false;
	}
}

function primitiveNumber(value: FoldedPrimitive): number {
	switch (value.kind) {
		case "number":
			return value.value;
		case "boolean":
			return value.value ? 1 : 0;
		case "null":
			return 0;
		case "undefined":
			return Number.NaN;
	}
}

function foldUnaryPrimitive(
	operator: Extract<IRInstruction, { type: "unary" }>["operator"],
	operand: FoldedPrimitive,
): FoldedPrimitive | undefined {
	switch (operator) {
		case "!":
			return { kind: "boolean", value: !primitiveTruthy(operand) };
		case "+":
			return { kind: "number", value: primitiveNumber(operand) };
		case "-":
			return { kind: "number", value: -primitiveNumber(operand) };
		case "~":
			return { kind: "number", value: ~primitiveNumber(operand) };
		case "typeof":
			return undefined;
	}
}

function foldNumericBinary(
	operator: Extract<IRInstruction, { type: "binary" }>["operator"],
	left: number,
	right: number,
): FoldedPrimitive | undefined {
	switch (operator) {
		case "+":
			return { kind: "number", value: left + right };
		case "-":
			return { kind: "number", value: left - right };
		case "*":
			return { kind: "number", value: left * right };
		case "/":
			return { kind: "number", value: left / right };
		case "%":
			return { kind: "number", value: left % right };
		case "**":
			// Keep host-dependent transcendental approximation out of the wire: the
			// Node and self-hosted compiler must serialize identical f64 bits.
			return undefined;
		case "&":
			return { kind: "number", value: left & right };
		case "|":
			return { kind: "number", value: left | right };
		case "^":
			return { kind: "number", value: left ^ right };
		case "<<":
			return { kind: "number", value: left << right };
		case ">>":
			return { kind: "number", value: left >> right };
		case ">>>":
			return { kind: "number", value: left >>> right };
		case "<":
			return { kind: "boolean", value: left < right };
		case "<=":
			return { kind: "boolean", value: left <= right };
		case ">":
			return { kind: "boolean", value: left > right };
		case ">=":
			return { kind: "boolean", value: left >= right };
		case "==":
		case "===":
			return { kind: "boolean", value: left === right };
		case "!=":
		case "!==":
			return { kind: "boolean", value: left !== right };
		case "in":
		case "instanceof":
			return undefined;
	}
}

function foldPrimitiveEquality(
	operator: Extract<IRInstruction, { type: "binary" }>["operator"],
	left: FoldedPrimitive,
	right: FoldedPrimitive,
): FoldedPrimitive | undefined {
	if (left.kind === "number" && right.kind === "number") {
		return foldNumericBinary(operator, left.value, right.value);
	}
	if (
		operator !== "===" &&
		operator !== "!==" &&
		operator !== "==" &&
		operator !== "!="
	) {
		return undefined;
	}

	const loose = operator === "==" || operator === "!=";
	let equal = false;
	if (left.kind === right.kind) {
		equal =
			left.kind !== "boolean" || (right.kind === "boolean" && left.value === right.value);
	} else if (loose) {
		equal =
			(left.kind === "null" && right.kind === "undefined") ||
			(left.kind === "undefined" && right.kind === "null") ||
			((left.kind === "number" || left.kind === "boolean") &&
				(right.kind === "number" || right.kind === "boolean") &&
				primitiveNumber(left) === primitiveNumber(right));
	}
	return {
		kind: "boolean",
		value: operator === "!==" || operator === "!=" ? !equal : equal,
	};
}

type FoldedInstruction =
	| Extract<IRInstruction, { type: "createF64" }>
	| Extract<IRInstruction, { type: "createBoolean" }>
	| Extract<IRInstruction, { type: "createNull" }>
	| Extract<IRInstruction, { type: "createUndefined" }>;

function foldedInstruction(
	destination: number,
	value: FoldedPrimitive,
): FoldedInstruction {
	switch (value.kind) {
		case "number":
			// F64 preserves NaN, infinities, and negative zero. Later representation
			// inference still unboxes it in generated C where possible.
			return { type: "createF64", registers: [destination], value: value.value };
		case "boolean":
			return { type: "createBoolean", registers: [destination], value: value.value };
		case "null":
			return { type: "createNull", registers: [destination] };
		case "undefined":
			return { type: "createUndefined", registers: [destination] };
	}
}

function optFoldPrimitiveConstants(program: IntermediateProgram): boolean {
	let changed = false;
	for (const fn of program.functions) {
		// Resumable functions can re-enter after an apparent single definition; their
		// continuation state needs a resume-aware constant lattice before this pass is
		// sound for values and branches spanning suspension points.
		if (fn.isGenerator || fn.isAsync) continue;
		const definitionCount = new Map<number, number>();
		const singleDefinition = new Map<number, IRInstruction>();
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				if (!("registers" in instruction)) continue;
				for (let i = 0; i < destinationCount(instruction); i++) {
					const register = instruction.registers[i]!;
					const count = (definitionCount.get(register) ?? 0) + 1;
					definitionCount.set(register, count);
					if (count === 1) singleDefinition.set(register, instruction);
					else singleDefinition.delete(register);
				}
			}
		}

		for (const block of fn.blocks) {
			const next: Array<IRInstruction> = [];
			for (const instruction of block.instructions) {
				let replacement: FoldedInstruction | undefined;
				if (instruction.type === "unary") {
					const operand = foldedPrimitive(singleDefinition.get(instruction.registers[1]));
					const result =
						operand === undefined
							? undefined
							: foldUnaryPrimitive(instruction.operator, operand);
					if (result !== undefined) {
						replacement = foldedInstruction(instruction.registers[0], result);
					}
				} else if (instruction.type === "binary") {
					const left = foldedPrimitive(singleDefinition.get(instruction.registers[1]));
					const right = foldedPrimitive(singleDefinition.get(instruction.registers[2]));
					const result =
						left === undefined || right === undefined
							? undefined
							: foldPrimitiveEquality(instruction.operator, left, right);
					if (result !== undefined) {
						replacement = foldedInstruction(instruction.registers[0], result);
					}
				} else if (instruction.type === "jumpIf") {
					const condition = foldedPrimitive(
						singleDefinition.get(instruction.registers[0]),
					);
					if (condition !== undefined) {
						changed = true;
						if (primitiveTruthy(condition)) {
							next.push({ type: "jump", blocks: instruction.blocks });
						}
						continue;
					}
				}

				if (replacement !== undefined) {
					changed = true;
					next.push(replacement);
					if (definitionCount.get(replacement.registers[0]) === 1) {
						singleDefinition.set(replacement.registers[0], replacement);
					}
				} else {
					next.push(instruction);
				}
			}
			block.instructions = next;
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
		changed = dropUnreferencedBlocksInFunction(fn) || changed;
	}

	return changed;
}

function dropUnreferencedBlocksInFunction(fn: IRFunction): boolean {
	const blockCount = fn.blocks.length;
	if (blockCount <= 1) {
		return false;
	}

	// Count explicit target and positional fall-through occurrences, not just
	// distinct source blocks. Peeling a block removes all of its outgoing
	// occurrences and can expose further zero-indegree blocks. Block zero remains
	// the function entry; cycles retain one another, matching the old behavior.
	const incoming = new Array<number>(blockCount).fill(0);
	for (let blockIndex = 0; blockIndex < blockCount; blockIndex++) {
		const block = fn.blocks[blockIndex]!;
		for (const instruction of block.instructions) {
			if ("blocks" in instruction) {
				for (const target of instruction.blocks) {
					incoming[target]!++;
				}
			}
		}
		const last = block.instructions.at(-1);
		const endsControlFlow =
			last?.type === "jump" || last?.type === "return" || last?.type === "throw";
		if (!endsControlFlow && blockIndex + 1 < blockCount) {
			incoming[blockIndex + 1]!++;
		}
	}

	const removed = new Array<boolean>(blockCount).fill(false);
	const worklist: Array<number> = [];
	for (let blockIndex = 1; blockIndex < blockCount; blockIndex++) {
		if (incoming[blockIndex] === 0) {
			worklist.push(blockIndex);
		}
	}
	const decrementIncoming = (target: number) => {
		incoming[target]!--;
		if (target !== 0 && incoming[target] === 0) {
			worklist.push(target);
		}
	};

	for (let cursor = 0; cursor < worklist.length; cursor++) {
		const blockIndex = worklist[cursor]!;
		removed[blockIndex] = true;
		const block = fn.blocks[blockIndex]!;
		for (const instruction of block.instructions) {
			if (!("blocks" in instruction)) {
				continue;
			}
			for (const target of instruction.blocks) {
				decrementIncoming(target);
			}
		}
		const last = block.instructions.at(-1);
		const endsControlFlow =
			last?.type === "jump" || last?.type === "return" || last?.type === "throw";
		if (!endsControlFlow && blockIndex + 1 < blockCount) {
			decrementIncoming(blockIndex + 1);
		}
	}

	if (worklist.length === 0) {
		return false;
	}

	const oldToNew = new Array<number | undefined>(blockCount);
	const blocks: IRFunction["blocks"] = [];
	for (let oldIndex = 0; oldIndex < blockCount; oldIndex++) {
		if (!removed[oldIndex]) {
			oldToNew[oldIndex] = blocks.length;
			blocks.push(fn.blocks[oldIndex]!);
		}
	}
	fn.blocks = blocks;
	patchBlockTargets(fn, oldToNew);
	patchBodyEntryBlock(fn, oldToNew);
	return true;
}

/**
 * Move all local variable usages to use registers.
 */
function optLocalsToRegister(program: IntermediateProgram): boolean {
	let changed = false;

	for (const fn of program.functions) {
		const localMap = new Map<number, number>();
		const storedLocals = new Set<number>();
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				if (instruction.type === "storeLocal") {
					storedLocals.add(instruction.index);
				}
			}
		}

		for (const block of fn.blocks) {
			for (let i = 0; i < block.instructions.length; ++i) {
				const instruction = block.instructions[i];
				if (instruction?.type !== "storeLocal" && instruction?.type !== "loadLocal") {
					continue;
				}
				if (instruction.type === "loadLocal" && !storedLocals.has(instruction.index)) {
					block.instructions[i] = {
						type: "createUndefined",
						registers: [instruction.registers[0]],
					};
					changed = true;
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
		changed = combineLinearBlocksInFunction(fn) || changed;
	}

	return changed;
}

function combineLinearBlocksInFunction(fn: IRFunction): boolean {
	const blockCount = fn.blocks.length;
	if (blockCount <= 1) {
		return false;
	}

	// Every occurrence matters: a jump plus either tryBegin target, two identical
	// tryBegin targets, or a backedge all make the target multi-referenced.
	const incoming = new Array<number>(blockCount).fill(0);
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			if ("blocks" in instruction) {
				for (const target of instruction.blocks) {
					incoming[target]!++;
				}
			}
		}
	}

	// mergeNext[i] means old block i+1 is folded into old block i. Eligible
	// edges can form chains; all decisions use the original CFG and indices.
	const mergeNext = new Array<boolean>(blockCount - 1).fill(false);
	let mergeCount = 0;
	for (let source = 0; source + 1 < blockCount; source++) {
		const lastInstruction = fn.blocks[source]!.instructions.at(-1);
		if (
			incoming[source + 1] === 1 &&
			lastInstruction?.type === "jump" &&
			lastInstruction.blocks[0] === source + 1
		) {
			mergeNext[source] = true;
			mergeCount++;
		}
	}
	if (mergeCount === 0) {
		return false;
	}

	const oldToNew = new Array<number | undefined>(blockCount);
	const blocks: IRFunction["blocks"] = [];
	for (let chainStart = 0; chainStart < blockCount; ) {
		const mergedInstructions: Array<IRInstruction> = [];
		let chainEnd = chainStart;
		while (chainEnd + 1 < blockCount && mergeNext[chainEnd]) {
			const instructions = fn.blocks[chainEnd]!.instructions;
			mergedInstructions.push(...instructions.slice(0, -1));
			chainEnd++;
		}
		mergedInstructions.push(...fn.blocks[chainEnd]!.instructions);

		const newIndex = blocks.length;
		for (let oldIndex = chainStart; oldIndex <= chainEnd; oldIndex++) {
			oldToNew[oldIndex] = newIndex;
		}
		const block = fn.blocks[chainStart]!;
		block.instructions = mergedInstructions;
		blocks.push(block);
		chainStart = chainEnd + 1;
	}

	fn.blocks = blocks;
	patchBlockTargets(fn, oldToNew);
	patchBodyEntryBlock(fn, oldToNew);
	return true;
}

function patchBlockTargets(fn: IRFunction, oldToNew: Array<number | undefined>) {
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			if (!("blocks" in instruction)) {
				continue;
			}
			for (let i = 0; i < instruction.blocks.length; i++) {
				instruction.blocks[i] = oldToNew[instruction.blocks[i]!]!;
			}
		}
	}
}

function patchBodyEntryBlock(fn: IRFunction, oldToNew: Array<number | undefined>) {
	if (fn.bodyEntryBlock === undefined) {
		return;
	}
	const newBodyEntry = oldToNew[fn.bodyEntryBlock];
	if (newBodyEntry === undefined) {
		delete fn.bodyEntryBlock;
	} else {
		fn.bodyEntryBlock = newBodyEntry;
	}
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
	if (
		!blocks.some((block) =>
			block.instructions.some((instr) => instr.type === "throwIfTdz"),
		)
	) {
		return;
	}

	// `with` (sloppy mode) introduces the empty sentinel through `withGet`, which
	// would defeat the empty-value tracking below. Such functions are never
	// native-backend eligible anyway, so skip them outright.
	for (const block of blocks) {
		for (const instr of block.instructions) {
			if (
				instr.type === "withGet" ||
				instr.type === "withResolveBase" ||
				instr.type === "withEnter"
			) {
				return;
			}
		}
	}

	// Blocks reached by a non-local edge (exception handler / tryEnd marker) are
	// pinned to "nothing initialized": a throw can arrive before any store ran.
	const pinnedEmpty = new Set<number>();
	const checkedSlots = new Set<number>();
	for (const block of blocks) {
		const regToSlot = new Map<number, number>();
		for (const instr of block.instructions) {
			if (instr.type === "tryBegin") {
				for (const target of instr.blocks) {
					pinnedEmpty.add(target);
				}
			} else if (instr.type === "loadLocal") {
				regToSlot.set(instr.registers[0], instr.index);
			} else if (instr.type === "throwIfTdz") {
				const slot = regToSlot.get(instr.registers[0]);
				if (slot !== undefined) {
					checkedSlots.add(slot);
				}
			}
		}
	}
	if (checkedSlots.size === 0) {
		return;
	}

	// Forward must-analysis: inSets[b] = local slots definitely initialized on
	// entry to b. Entry/exception blocks start empty; the rest start at top (all
	// checked slots) and are intersected down to a fixpoint. A `jumpIf` continues
	// in-block when not taken, so it is a branch — not a terminator.
	const inSets: Array<Set<number>> = blocks.map((_, b) =>
		b === 0 || pinnedEmpty.has(b) ? new Set<number>() : new Set(checkedSlots),
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
				} else if (instr.type === "storeLocal" && checkedSlots.has(instr.index)) {
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
					if (!checkedSlots.has(instr.index)) {
						break;
					}
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

export const irOptTestHooks = {
	dropUnreferencedBlocksInFunction,
	combineLinearBlocksInFunction,
	eliminateRedundantTdzChecksInFunction,
	foldPrimitiveConstants: optFoldPrimitiveConstants,
};

/**
 * IR instruction kinds whose `registers[0]` is a SOURCE (read), not a freshly
 * written destination, and which write no register at all (they target a slot,
 * global, property, or control flow). For these every register operand is a use
 * and copy propagation may rewrite all of them. Anything not listed is assumed
 * to write `registers[0]` (so it is left untouched and invalidated), the safe
 * direction. Kept to clearly source-only ops.
 */
const WRITES_NO_REGISTER = new Set<IRInstruction["type"]>([
	"return",
	"throw",
	"jump",
	"jumpIf",
	"storeLocal",
	"storeGlobal",
	"storeCaptured",
	"storeGlobalProperty",
	"storeProperty",
	"storePropertyStatic",
	"storeSuperProperty",
	"setPrototype",
	"requireCoercible",
	"throwIfTdz",
	"defineProperty",
	"defineAccessor",
	"mergeDataProperties",
	"setFunctionName",
	"withEnter",
]);

/** IR kinds that write two leading destination registers (the iterator pairs). */
const TWO_DESTINATIONS = new Set<IRInstruction["type"]>([
	"getIterator",
	"getAsyncIterator",
	"iteratorStep",
]);

/** Whether a function contains any `with`-statement op (dynamic scoping). */
function functionUsesWith(fn: IRFunction): boolean {
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			if (
				instruction.type === "withEnter" ||
				instruction.type === "withExit" ||
				instruction.type === "withGet" ||
				instruction.type === "withResolveBase" ||
				instruction.type === "withSet"
			) {
				return true;
			}
		}
	}
	return false;
}

/** The number of leading `registers` entries an instruction writes (defines). */
export function destinationCount(instruction: IRInstruction): number {
	if (!("registers" in instruction) || WRITES_NO_REGISTER.has(instruction.type)) {
		return 0;
	}
	return TWO_DESTINATIONS.has(instruction.type) ? 2 : 1;
}

/**
 * Local (intra-block) copy propagation: after `move [dst, src]`, rewrite later
 * reads of `dst` in the same block to `src`, until either is reassigned. The
 * `move` is left in place; once all its in-block readers point at `src` and
 * `dst` has no other use, optDeadInstructionElimination removes it. MOVE is the
 * most common opcode (the front end copies a value into a working register
 * before almost every use), so this shrinks both backends' output broadly.
 *
 * Safety: only operands past an instruction's destination registers are
 * rewritten (a destination is never altered), and a register is dropped from the
 * active copies the moment it — or the value it copies — is written. Copies do
 * not cross block boundaries.
 */
function optCopyPropagation(program: IntermediateProgram): boolean {
	let changed = false;

	for (const fn of program.functions) {
		// `with` makes variable resolution dynamic and lowers to a withGet →
		// fallback shape that writes one result register across several blocks; its
		// register liveness does not fit the simple intra-block model here, so skip
		// such functions entirely (they are rare, sloppy-mode-only).
		if (functionUsesWith(fn)) {
			continue;
		}

		for (const block of fn.blocks) {
			// copyOf.get(d) === s means register d currently holds the same value as
			// register s (read s instead of d).
			const copyOf = new Map<number, number>();

			const invalidate = (register: number) => {
				copyOf.delete(register);
				for (const [dst, src] of copyOf) {
					if (src === register) {
						copyOf.delete(dst);
					}
				}
			};

			for (const instruction of block.instructions) {
				if (!("registers" in instruction)) {
					continue;
				}
				const defs = destinationCount(instruction);

				// Rewrite use operands (those past the destinations) to their source.
				for (let i = defs; i < instruction.registers.length; i++) {
					const register = instruction.registers[i]!;
					const source = copyOf.get(register);
					if (source !== undefined && source !== register) {
						instruction.registers[i] = source;
						changed = true;
					}
				}

				// A reassigned register (and any copy of it) is no longer current.
				for (let i = 0; i < defs; i++) {
					invalidate(instruction.registers[i]!);
				}

				// Record the new copy. The source was already rewritten above, so this
				// collapses chains (a = b; c = a → c copies b).
				if (instruction.type === "move" && defs === 1) {
					const dst = instruction.registers[0];
					const src = instruction.registers[1];
					if (dst >= 0 && src >= 0 && dst !== src) {
						copyOf.set(dst, src);
					}
				}
			}
		}
	}

	return changed;
}

/**
 * Scalar-replace non-escaping object literals — the first slice of escape
 * analysis (see docs/roadmaps/gc.md).
 *
 * A `createObjectShaped` builds an immutable record with statically-known, unique,
 * non-index string keys (`staticObjectShape` already excludes spread, computed
 * keys, accessors, methods, `__proto__`, duplicates and index-like names). When
 * such a record never escapes — its destination register is used ONLY as the
 * object operand of `loadProperty` reads, each with a constant key that is an own
 * key of the record — the object is unobservable: its identity is never taken and
 * every read resolves to a known slot. We then delete the allocation and rewrite
 * each read `loadProperty [d, obj, keyᵢ]` into `move [d, valueᵢ]`, where `valueᵢ`
 * is the register the literal stored for that key. The now-dead key constants and
 * any unread values are removed by the following DCE pass.
 *
 * This removes the allocation entirely — the GC never sees the object — which is
 * the Phase-7 lever that beats merely shrinking root frames. It is conservative by
 * construction: any use we do not recognise (escaping into a call/return/store,
 * mutation via `storeProperty`, a computed or foreign key, `delete`, an identity
 * compare, …) leaves the site untouched.
 *
 * Gating: skipped for functions that can observe locals dynamically — `with`
 * (sloppy scope) and direct `eval` (C3) — and for generator/async bodies, where a
 * value live across a suspension has a subtler lifetime (C5, deferred).
 *
 * Soundness conditions, all required:
 *  - the record register is single-assignment (exactly one defining instruction);
 *  - every key register is a single `createString` whose index is an own key of
 *    the record (a read of any other key would resolve up the prototype chain).
 *
 * Value freshness is handled by *snapshotting*: at the (deleted) allocation site we
 * emit `move [snapᵢ, valueᵢ]` into a fresh single-assignment register, and rewrite
 * each read to `move [d, snapᵢ]`. The snapshot captures the value at construction
 * time, so the result is correct even when the source is reassigned afterwards —
 * crucially inside loops, where the per-iteration object is the prize. Copy
 * propagation collapses the snapshot back to a direct move (and DCE drops it) wherever
 * the source is provably unchanged, so the common case costs nothing.
 */
function optScalarReplaceObjectLiterals(program: IntermediateProgram): boolean {
	let changed = false;
	for (const fn of program.functions) {
		// C5: a value live across a yield/await is frame-resident; skip for now.
		if (fn.isGenerator || fn.isAsync) {
			continue;
		}
		// C3: `with` / direct `eval` can reach a local without an explicit IR use,
		// so the use scan below would be unsound. `hasDirectEval` is file-scoped, so
		// this conservatively disables the pass for every function in a file that
		// contains a direct eval — acceptable, as direct eval is rare.
		if (functionUsesWith(fn) || fn.semanticFile.hasDirectEval.size > 0) {
			continue;
		}
		changed = scalarReplaceObjectLiteralsInFunction(fn) || changed;
	}
	return changed;
}

function scalarReplaceObjectLiteralsInFunction(fn: IRFunction): boolean {
	// Per-register count of defining instructions, and the string index of every
	// register whose sole definition is a `createString` (a usable constant key).
	const defCount = new Map<number, number>();
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			if (!("registers" in instruction)) {
				continue;
			}
			const defs = destinationCount(instruction);
			for (let i = 0; i < defs; i++) {
				const register = instruction.registers[i]!;
				defCount.set(register, (defCount.get(register) ?? 0) + 1);
			}
		}
	}

	const constStringIndex = new Map<number, number>();
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			if (
				instruction.type === "createString" &&
				defCount.get(instruction.registers[0]) === 1
			) {
				constStringIndex.set(instruction.registers[0], instruction.stringIndex);
			}
		}
	}

	// Every USE of each register: the instruction plus the operand position. A
	// position below the instruction's destination count is a definition, not a use.
	const usesOf = new Map<
		number,
		Array<{ instruction: IRInstruction; position: number }>
	>();
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			if (!("registers" in instruction)) {
				continue;
			}
			const defs = destinationCount(instruction);
			for (let position = defs; position < instruction.registers.length; position++) {
				const register = instruction.registers[position]!;
				if (register < 0) {
					continue;
				}
				const list = usesOf.get(register) ?? usesOf.set(register, []).get(register)!;
				list.push({ instruction, position });
			}
		}
	}

	// Each firing record maps to the snapshot moves that replace its allocation;
	// its alias-copy moves become dead and are dropped.
	const snapshotsFor = new Map<
		IRInstruction,
		Array<{ snapshot: number; value: number }>
	>();
	const aliasMovesToDrop = new Set<IRInstruction>();
	let changed = false;

	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			if (instruction.type !== "createObjectShaped") {
				continue;
			}
			const objectRegister = instruction.registers[0];
			if (defCount.get(objectRegister) !== 1) {
				continue; // not single-assignment — can't reason about its contents
			}
			const keys = instruction.keyStringIndices;
			// registers = [destination, ...valueRegisters], parallel to keys.
			const valueRegisters = instruction.registers.slice(1);

			// The record may be read directly OR after being copied (once) into a
			// single-assignment register — a move-alias closure. This is what makes the
			// pass work across blocks: copy propagation is intra-block, so a record read
			// in a later block reaches its reads through a `move` (the local slot) rather
			// than the allocation register. Every use across the closure must be a
			// static-own-key `loadProperty` read or a `move` into another
			// single-assignment register (extending the alias set); any other use escapes
			// and leaves the site alone.
			const reads: Array<{ load: IRInstruction; keyIndex: number }> = [];
			const aliasMoves: Array<IRInstruction> = [];
			const aliasSet = new Set<number>([objectRegister]);
			const worklist = [objectRegister];
			let safe = true;
			while (safe && worklist.length > 0) {
				const aliasRegister = worklist.pop()!;
				for (const { instruction: use, position } of usesOf.get(aliasRegister) ?? []) {
					if (use.type === "loadProperty" && position === 1) {
						const stringIndex = constStringIndex.get(use.registers[2]);
						if (stringIndex === undefined) {
							safe = false; // non-constant or multiply-defined key
							break;
						}
						const keyIndex = keys.indexOf(stringIndex);
						if (keyIndex < 0) {
							safe = false; // a key not on the record → would hit the prototype
							break;
						}
						reads.push({ load: use, keyIndex });
					} else if (use.type === "move" && position === 1) {
						// `move [target, alias]` copies the record into `target`. Following it
						// is sound only if `target` is single-assignment (so it always holds
						// the record); its uses are then checked transitively.
						const target = use.registers[0];
						if (defCount.get(target) !== 1) {
							safe = false;
							break;
						}
						if (!aliasSet.has(target)) {
							aliasSet.add(target);
							worklist.push(target);
						}
						aliasMoves.push(use);
					} else {
						safe = false; // escapes / mutated / used as a key — leave the site alone
						break;
					}
				}
			}
			if (!safe) {
				continue;
			}

			// Allocate one snapshot register per distinct read key, rewrite each read
			// into a move from it, and record the snapshot moves that take the
			// allocation's place. Keys never read need no snapshot (their value, if
			// otherwise unused, is dropped by the following DCE pass).
			const snapshotForKey = new Map<number, number>();
			for (const { load, keyIndex } of reads) {
				let snapshot = snapshotForKey.get(keyIndex);
				if (snapshot === undefined) {
					snapshot = fn.nextRegisterDestination++;
					snapshotForKey.set(keyIndex, snapshot);
				}
				// `load` was validated as a `loadProperty`; retype it in place to the
				// structurally-identical `move [destination, snapshot]`.
				const mutable = load as { type: string; registers: Array<number> };
				mutable.registers = [mutable.registers[0]!, snapshot];
				mutable.type = "move";
			}
			snapshotsFor.set(
				instruction,
				[...snapshotForKey].map(([keyIndex, snapshot]) => ({
					snapshot,
					value: valueRegisters[keyIndex]!,
				})),
			);
			// The alias-copy moves now feed only rewritten reads, so they are dead.
			for (const move of aliasMoves) {
				aliasMovesToDrop.add(move);
			}
			changed = true;
		}
	}

	// Replace each firing allocation with its snapshot moves (capturing the values
	// at the construction point) and drop the now-dead alias-copy moves, in place.
	if (snapshotsFor.size > 0) {
		for (const block of fn.blocks) {
			const next: Array<IRInstruction> = [];
			for (const instruction of block.instructions) {
				const snapshots = snapshotsFor.get(instruction);
				if (snapshots !== undefined) {
					for (const { snapshot, value } of snapshots) {
						next.push({ type: "move", registers: [snapshot, value] });
					}
					continue;
				}
				if (aliasMovesToDrop.has(instruction)) {
					continue;
				}
				next.push(instruction);
			}
			block.instructions = next;
		}
	}

	return changed;
}

/**
 * Property names that exist on `Object.prototype` (and `Array.prototype` shares the
 * data-vs-accessor concern via `__proto__`). A property read of one of these on a
 * fresh object can resolve up the prototype chain (e.g. `o.toString`), and a write
 * to `__proto__` invokes the prototype's setter — so a key NOT present in an
 * object's own literal that names one of these cannot be modelled as a plain own
 * slot. Used to keep the mutable scalar-replacement sound when a store introduces a
 * key the literal did not declare. Keys that ARE in the literal are own data
 * properties (shadowing the prototype) and need no check.
 */
const PROTOTYPE_POLLUTING_KEYS = new Set<string>([
	"constructor",
	"hasOwnProperty",
	"isPrototypeOf",
	"propertyIsEnumerable",
	"toLocaleString",
	"toString",
	"valueOf",
	"__proto__",
	"__defineGetter__",
	"__defineSetter__",
	"__lookupGetter__",
	"__lookupSetter__",
]);

/**
 * Scalar-replace a non-escaping object that IS mutated — the general (mutable)
 * extension of `optScalarReplaceObjectLiterals` (see docs/roadmaps/gc.md).
 *
 * The immutable pass above eliminates records that are only ever read. This pass
 * handles records that are also *written* (`storeProperty`), the builder /
 * accumulator idiom (`const o = {…}; o.k = …; … o.k …`). The model: give each
 * own key its own **mutable register** ("field register"). A store `o.k = v`
 * becomes `move [fieldₖ, v]`; a read `r = o.k` becomes `move [r, fieldₖ]`; the
 * allocation is deleted and each field register is initialised at the (former)
 * construction site (the literal value, or `undefined` for a key the literal did
 * not declare).
 *
 * Why no phi / merge machinery is needed: the rewrites happen *in place*, so the
 * field register is read and written in exactly the original program order along
 * every path. A control-flow merge leaves the field register holding whatever the
 * last dynamically-executed store wrote — identical to the object's field. This
 * makes the transform correct for arbitrary control flow (branches AND loops: a
 * loop-carried `o.sum += x` becomes a loop-carried `fieldₛᵤₘ = fieldₛᵤₘ + x`).
 *
 * Soundness conditions (any violation ⇒ the object is left as a real allocation):
 *  - the object register is single-assignment (one `createObject`/`createObjectShaped`);
 *  - it has at least one store (else the immutable pass owns it);
 *  - EVERY use, across its single-assignment `move`-alias closure, is a constant
 *    own-key `loadProperty` read (object operand), a constant-key `storeProperty`
 *    write (object operand), or such an alias `move`. Anything else — a dynamic
 *    key, the object as a stored value / call arg / return / `===` operand, a
 *    `delete`, an enumeration — means the identity or full contents escape;
 *  - every key is either declared by the literal (an own data slot, always safe)
 *    or a non-`Object.prototype` name (safe to model as `undefined`-until-written,
 *    because a missing own read returns `undefined` and a write creates an own
 *    data property — neither touches the prototype). A `__proto__`/`toString`/…
 *    key the literal did not declare bails.
 *
 * Gating mirrors the immutable pass: skipped under generator/async (a value live
 * across a suspension is frame-resident, C5) and `with`/direct-`eval` (C3).
 */
function optScalarReplaceMutableObjects(program: IntermediateProgram): boolean {
	let changed = false;
	for (const fn of program.functions) {
		if (fn.isGenerator || fn.isAsync) {
			continue;
		}
		if (functionUsesWith(fn) || fn.semanticFile.hasDirectEval.size > 0) {
			continue;
		}
		changed = scalarReplaceMutableObjectsInFunction(program, fn) || changed;
	}
	return changed;
}

function scalarReplaceMutableObjectsInFunction(
	program: IntermediateProgram,
	fn: IRFunction,
): boolean {
	const defCount = new Map<number, number>();
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			if (!("registers" in instruction)) {
				continue;
			}
			const defs = destinationCount(instruction);
			for (let i = 0; i < defs; i++) {
				const register = instruction.registers[i]!;
				if (register >= 0) {
					defCount.set(register, (defCount.get(register) ?? 0) + 1);
				}
			}
		}
	}

	// Registers whose sole definition is a `createString` → its string index (a
	// usable constant property key).
	const constStringIndex = new Map<number, number>();
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			if (
				instruction.type === "createString" &&
				defCount.get(instruction.registers[0]) === 1
			) {
				constStringIndex.set(instruction.registers[0], instruction.stringIndex);
			}
		}
	}

	// Every use of each register: instruction + operand position (positions below
	// the destination count are definitions, not uses).
	const usesOf = new Map<
		number,
		Array<{ instruction: IRInstruction; position: number }>
	>();
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			if (!("registers" in instruction)) {
				continue;
			}
			const defs = destinationCount(instruction);
			for (let position = defs; position < instruction.registers.length; position++) {
				const register = instruction.registers[position]!;
				if (register < 0) {
					continue;
				}
				const list = usesOf.get(register) ?? usesOf.set(register, []).get(register)!;
				list.push({ instruction, position });
			}
		}
	}

	// In-place rewrites recorded across all objects in this function, applied once
	// at the end. `claimed` prevents two objects from rewriting the same instruction
	// (which would be unsound); the second object to touch it simply bails.
	const replaceAlloc = new Map<IRInstruction, Array<IRInstruction>>();
	const dropInstruction = new Set<IRInstruction>();
	const claimed = new Set<IRInstruction>();
	let changed = false;

	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			if (
				instruction.type !== "createObject" &&
				instruction.type !== "createObjectShaped"
			) {
				continue;
			}
			const objectRegister = instruction.registers[0];
			if (defCount.get(objectRegister) !== 1) {
				continue;
			}

			// Literal keys → the value register that initialises each (shaped only).
			const literalKeys =
				instruction.type === "createObjectShaped" ? instruction.keyStringIndices : [];
			const literalValueRegister = new Map<number, number>();
			if (instruction.type === "createObjectShaped") {
				const valueRegisters = instruction.registers.slice(1);
				for (let i = 0; i < literalKeys.length; i++) {
					literalValueRegister.set(literalKeys[i]!, valueRegisters[i]!);
				}
			}
			const literalKeySet = new Set(literalKeys);

			// Walk the object's single-assignment alias closure, classifying every use.
			const reads: Array<{ load: IRInstruction; keyStringIndex: number }> = [];
			const stores: Array<{ store: IRInstruction; keyStringIndex: number }> = [];
			const aliasMoves: Array<IRInstruction> = [];
			const touched: Array<IRInstruction> = [instruction];
			const aliasSet = new Set<number>([objectRegister]);
			const worklist = [objectRegister];
			let safe = true;
			let hasStore = false;

			while (safe && worklist.length > 0) {
				const aliasRegister = worklist.pop()!;
				for (const { instruction: use, position } of usesOf.get(aliasRegister) ?? []) {
					if (use.type === "loadProperty" && position === 1) {
						const keyStringIndex = constStringIndex.get(use.registers[2]);
						if (keyStringIndex === undefined) {
							safe = false;
							break;
						}
						reads.push({ load: use, keyStringIndex });
						touched.push(use);
					} else if (use.type === "storeProperty" && position === 0) {
						const keyStringIndex = constStringIndex.get(use.registers[1]);
						if (keyStringIndex === undefined) {
							safe = false;
							break;
						}
						stores.push({ store: use, keyStringIndex });
						touched.push(use);
						hasStore = true;
					} else if (use.type === "move" && position === 1) {
						const target = use.registers[0];
						if (defCount.get(target) !== 1) {
							safe = false;
							break;
						}
						if (!aliasSet.has(target)) {
							aliasSet.add(target);
							worklist.push(target);
						}
						aliasMoves.push(use);
						touched.push(use);
					} else {
						safe = false; // escapes / mutated via accessor / dynamic key / identity
						break;
					}
				}
			}

			// Only objects that are written; pure-read records are the immutable pass's.
			if (!safe || !hasStore) {
				continue;
			}

			// Every key must be a literal own slot or a prototype-safe new key.
			let keysSafe = true;
			for (const { keyStringIndex } of [...reads, ...stores]) {
				if (literalKeySet.has(keyStringIndex)) {
					continue;
				}
				if (PROTOTYPE_POLLUTING_KEYS.has(decodeStringConstant(program, keyStringIndex))) {
					keysSafe = false;
					break;
				}
			}
			if (!keysSafe) {
				continue;
			}

			// Don't let two objects rewrite the same instruction.
			if (touched.some((i) => claimed.has(i))) {
				continue;
			}

			// A field register per key that is READ (a key only ever written produces a
			// dead store we simply drop). Initialised at the construction site.
			const readKeys = new Set(reads.map((r) => r.keyStringIndex));
			const fieldRegister = new Map<number, number>();
			const init: Array<IRInstruction> = [];
			for (const key of readKeys) {
				const register = fn.nextRegisterDestination++;
				fieldRegister.set(key, register);
				const literalValue = literalValueRegister.get(key);
				if (literalValue !== undefined) {
					init.push({ type: "move", registers: [register, literalValue] });
				} else {
					init.push({ type: "createUndefined", registers: [register] });
				}
			}

			// Rewrite reads → move-from-field, live stores → move-to-field, drop dead
			// stores (a key never read) and the alias copies (now dead).
			for (const { load, keyStringIndex } of reads) {
				const mutable = load as { type: string; registers: Array<number> };
				mutable.registers = [mutable.registers[0]!, fieldRegister.get(keyStringIndex)!];
				mutable.type = "move";
			}
			for (const { store, keyStringIndex } of stores) {
				const register = fieldRegister.get(keyStringIndex);
				if (register === undefined) {
					dropInstruction.add(store); // dead write to a never-read field
					continue;
				}
				const mutable = store as { type: string; registers: Array<number> };
				mutable.registers = [register, mutable.registers[2]!];
				mutable.type = "move";
			}
			for (const move of aliasMoves) {
				dropInstruction.add(move);
			}
			replaceAlloc.set(instruction, init);
			for (const i of touched) {
				claimed.add(i);
			}
			changed = true;
		}
	}

	if (!changed) {
		return false;
	}
	for (const block of fn.blocks) {
		const next: Array<IRInstruction> = [];
		for (const instruction of block.instructions) {
			const init = replaceAlloc.get(instruction);
			if (init !== undefined) {
				next.push(...init);
				continue;
			}
			if (dropInstruction.has(instruction)) {
				continue;
			}
			next.push(instruction);
		}
		block.instructions = next;
	}
	return true;
}

/**
 * Remove side-effect-free instructions whose destination register is never read
 * anywhere in the function. Iterated to a fixpoint per function, so dropping one
 * dead value can expose the instructions that fed it. This cleans up values the
 * front end produced but never consumed (e.g. loads left orphaned once their
 * only reader — a redundant TDZ check — was eliminated) and shrinks both
 * backends' output.
 *
 * A register is "read" wherever it appears as a use. Only a SIDE_EFFECT_FREE op
 * has a known single destination — its `registers[0]` — so only there is the
 * first register excluded from the read set; for every other instruction all
 * registers are treated as uses. That asymmetry is the safety margin: a use is
 * never misclassified as a definition (which would wrongly drop its producer),
 * while at worst a real definition is treated as a use (merely keeping a dead
 * instruction). A side-effect-free instruction whose `registers[0]` is never
 * read is then dead.
 */
function optDeadInstructionElimination(program: IntermediateProgram): boolean {
	let changed = false;

	for (const fn of program.functions) {
		let localChanged = true;
		while (localChanged) {
			localChanged = false;

			const read = new Set<number>();
			for (const block of fn.blocks) {
				for (const instruction of block.instructions) {
					if (!("registers" in instruction)) {
						continue;
					}
					// Skip registers[0] only for a side-effect-free op, where it is
					// definitely the (sole) destination; otherwise count every register.
					const firstIsUse = !SIDE_EFFECT_FREE_OPS.has(instruction.type);
					for (let i = 0; i < instruction.registers.length; i++) {
						const register = instruction.registers[i]!;
						if (register >= 0 && (firstIsUse || i > 0)) {
							read.add(register);
						}
					}
				}
			}

			for (const block of fn.blocks) {
				const kept = block.instructions.filter((instruction) => {
					if (
						!SIDE_EFFECT_FREE_OPS.has(instruction.type) ||
						!("registers" in instruction)
					) {
						return true;
					}
					const dst = instruction.registers[0];
					if (dst === undefined || dst < 0 || read.has(dst)) {
						return true;
					}
					localChanged = true;
					changed = true;
					return false;
				});
				if (kept.length !== block.instructions.length) {
					block.instructions = kept;
				}
			}
		}
	}

	return changed;
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
