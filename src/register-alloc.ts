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
 * How a register's value is held downstream (drives rep-aware allocation). Must
 * mirror emit-c's rep lattice (its `inferReps`/`producedRep`) exactly: a physical
 * register is kept to a single rep so the native backend can hold `number`
 * registers as C doubles and `boolean` registers as C bools. If the allocator
 * coalesced values of differing rep into one physical register, emit-c's join
 * would demote it to `boxed`, collapsing the native fast paths — which is what
 * made hot `%`/comparison results (and the accumulators they feed) box.
 */
type RegisterRep = "boxed" | "number" | "boolean";

/** Comparison operators emit-c lowers to a native C bool. Result rep: boolean. */
const COMPARE_OPERATORS = new Set(["<", "<=", ">", ">=", "===", "==", "!==", "!="]);

/**
 * Binary operators emit-c lowers to native C over two `number` operands: the
 * arithmetic set, the bitwise/shift ops, unsigned shift, and float remainder.
 * Mirrors emit-c's `producesNumberFromNumbers`; `**` is excluded (stays boxed).
 */
const NUMBER_FROM_NUMBERS = new Set([
	"+",
	"-",
	"*",
	"/",
	"&",
	"|",
	"^",
	"<<",
	">>",
	">>>",
	"%",
]);

/**
 * Blocks in reverse postorder — a valid execution linearization in which every
 * block precedes the blocks reachable only through it (so a register's definition
 * is iterated before its uses, except across loop back-edges). The allocator's
 * last-use/free model assumes exactly that ordering; block-appending IR transforms
 * (inlining, HOF substitution) can place a definition block *after* a use block in
 * array order, which made the allocator assign a still-live result register to a
 * just-freed operand. Iterating in RPO restores the invariant. Sound because the IR
 * has no positional fall-through — control flow is entirely explicit jump/jumpIf/
 * tryBegin edges. Unreachable blocks are appended in array order.
 */
function reversePostorderBlocks(fn: IRFunction): Array<IRBlock> {
	const successorsOf = (block: IRBlock): Array<number> => {
		const targets: Array<number> = [];
		for (const instruction of block.instructions) {
			if (
				instruction.type === "jump" ||
				instruction.type === "jumpIf" ||
				instruction.type === "tryBegin"
			) {
				for (const target of instruction.blocks) {
					targets.push(target);
				}
			}
		}
		return targets;
	};

	const visited = new Array<boolean>(fn.blocks.length).fill(false);
	const postorder: Array<number> = [];
	if (fn.blocks.length > 0) {
		// Iterative DFS (a deep function body could overflow a recursive walk).
		const stack: Array<{ index: number; next: number }> = [{ index: 0, next: 0 }];
		visited[0] = true;
		while (stack.length > 0) {
			const top = stack[stack.length - 1]!;
			const succ = successorsOf(fn.blocks[top.index]!);
			if (top.next < succ.length) {
				const target = succ[top.next++]!;
				if (target >= 0 && target < fn.blocks.length && !visited[target]) {
					visited[target] = true;
					stack.push({ index: target, next: 0 });
				}
			} else {
				postorder.push(top.index);
				stack.pop();
			}
		}
	}

	const ordered: Array<IRBlock> = [];
	for (let i = postorder.length - 1; i >= 0; --i) {
		ordered.push(fn.blocks[postorder[i]!]!);
	}
	for (let i = 0; i < fn.blocks.length; ++i) {
		if (!visited[i]) {
			ordered.push(fn.blocks[i]!);
		}
	}
	return ordered;
}

/**
 * IR instructions whose registers[0] is a *source*, not a freshly written
 * destination. Everything else that writes registers[0] is treated as a
 * definition; conservatively over-treating a source as a definition only costs
 * an unboxing, but missing a real definition would be unsound, so this list is
 * kept to clearly source-only ops.
 */
const USE_ONLY_FIRST_REGISTER = new Set([
	"return",
	"throw",
	"jump",
	"jumpIf",
	"storeLocal",
	"storeGlobal",
	"storeCaptured",
	"storeProperty",
	"storeSuperProperty",
	"storeGlobalProperty",
	"mergeDataProperties",
	"defineAccessor",
	"defineProperty",
	"definePrivate",
	"storePrivate",
	"setPrototype",
	"setFunctionName",
	"iteratorClose",
	"withEnter",
	"checkSuperClass",
	"requireCoercible",
	// A temporal-dead-zone guard: throws if its operand is the TDZ sentinel and
	// otherwise passes the value through unchanged (lowers to THROW_IF_TDZ { src },
	// no destination — like requireCoercible). Modelling it as a definition would
	// inflate the operand's def count and defeat every single-assignment analysis
	// (inliner callee resolution, escape, scalar replacement) for the `let`/`const`
	// bindings that emit a `throwIfTdz` on every read.
	"throwIfTdz",
]);

/**
 * The rep an IR instruction's result naturally has given current operand reps, or
 * null when an operand is still unknown (defer to a later fixpoint iteration).
 * Mirrors emit-c's `producedRep`: comparisons and `!` yield a boolean; native
 * arithmetic/bitwise/remainder over two numbers yields a number; unary `- + ~`
 * over a number yields a number; everything else is boxed.
 */
function producedRep(
	instruction: IRInstruction,
	repOf: (register: number) => RegisterRep | null,
): RegisterRep | null {
	switch (instruction.type) {
		case "createNumber":
		case "createF64":
			return "number";
		case "createBoolean":
			return "boolean";
		case "move":
			return repOf(instruction.registers[1]);
		case "binary": {
			const op = instruction.operator;
			if (COMPARE_OPERATORS.has(op)) {
				return "boolean";
			}
			if (NUMBER_FROM_NUMBERS.has(op)) {
				const left = repOf(instruction.registers[1]);
				const right = repOf(instruction.registers[2]);
				if (left === null || right === null) {
					return null;
				}
				return left === "number" && right === "number" ? "number" : "boxed";
			}
			return "boxed";
		}
		case "unary": {
			const op = instruction.operator;
			if (op === "!") {
				return "boolean";
			}
			if (op === "-" || op === "+" || op === "~") {
				const src = repOf(instruction.registers[1]);
				return src === null ? null : src === "number" ? "number" : "boxed";
			}
			return "boxed";
		}
		default:
			return "boxed";
	}
}

/** Join two reps of a multiply-defined register: any disagreement is boxed. */
function joinReps(current: RegisterRep | null, produced: RegisterRep): RegisterRep {
	if (current === null) {
		return produced;
	}
	return current === produced ? current : "boxed";
}

/** The virtual register an instruction defines (writes), or null. */
export function definedRegister(instruction: IRInstruction): number | null {
	if (!("registers" in instruction) || USE_ONLY_FIRST_REGISTER.has(instruction.type)) {
		return null;
	}
	const dst = instruction.registers[0];
	return dst !== undefined && dst >= 0 ? dst : null;
}

/**
 * Forward fixpoint over virtual registers (top = unknown, then {number, boolean},
 * bottom = boxed): a register's rep is the join of the reps its definitions
 * produce. `producedRep` depends on operand reps, so iterate to a fixpoint; reps
 * only move down the lattice, so it converges. Parameters hold boxed incoming
 * arguments, so they start (and stay) `boxed`; a register never resolved (only
 * ever a non-first / iterator output, or unwritten) defaults to `boxed`.
 */
function inferVirtualReps(fn: IRFunction): Map<number, RegisterRep> {
	const reps = new Map<number, RegisterRep | null>();
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			if (!("registers" in instruction)) {
				continue;
			}
			for (const register of instruction.registers) {
				if (register >= 0 && !reps.has(register)) {
					reps.set(register, register < fn.parameterCount ? "boxed" : null);
				}
			}
		}
	}

	const repOf = (register: number): RegisterRep | null => reps.get(register) ?? "boxed";

	let changed = true;
	while (changed) {
		changed = false;
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				const dst = definedRegister(instruction);
				if (dst === null || dst < fn.parameterCount) {
					continue;
				}
				const produced = producedRep(instruction, repOf);
				// An operand still unknown: leave for a later iteration.
				if (produced === null) {
					continue;
				}
				const joined = joinReps(reps.get(dst) ?? null, produced);
				if (joined !== reps.get(dst)) {
					reps.set(dst, joined);
					changed = true;
				}
			}
		}
	}

	const resolved = new Map<number, RegisterRep>();
	for (const [register, rep] of reps) {
		resolved.set(register, rep ?? "boxed");
	}
	return resolved;
}

/**
 * Allocate registers for a function. Rep-aware: a freed physical register is
 * only reused for a virtual register of the same representation, so each
 * physical register holds a single rep across its life. That lets the native
 * backend keep `number` registers unboxed (in C doubles) instead of having a
 * boolean/object/argument poison a register it shares.
 */
function allocateRegistersForFunction(fn: IRFunction) {
	// Iterate in reverse postorder so a register's definition is seen before its
	// uses (see reversePostorderBlocks); the last-use/free model below depends on it.
	const orderedBlocks = reversePostorderBlocks(fn);

	// Use referential equality to track last use of virtual registers
	const registerLastUsedIn = new Map<number, IRInstruction>();
	const registerUsedInMultipleBlocks = new Map<number, Set<IRBlock>>();

	for (const block of orderedBlocks) {
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

	const virtualReps = inferVirtualReps(fn);
	const repOf = (register: number): RegisterRep => virtualReps.get(register) ?? "boxed";

	const virtualRegisterToRealRegister = new Map<number, number>();
	const freeRegisters: Record<RegisterRep, Array<number>> = {
		boxed: [],
		number: [],
		boolean: [],
	};
	let highestUsedRegister = -1;

	// A register used in multiple blocks may be live across a loop back edge,
	// which the last-static-use model cannot see; those are never freed. Nor are
	// parameter registers, whose physical register holds a boxed incoming
	// argument and must not be reused for, say, a numeric literal.
	const isFreeable = (virtualRegister: number, instruction: IRInstruction) =>
		virtualRegister >= fn.parameterCount &&
		instruction === registerLastUsedIn.get(virtualRegister) &&
		(registerUsedInMultipleBlocks.get(virtualRegister)?.size ?? 0) <= 1;

	// The VM places arguments in the first registers of the frame. Parameters are
	// compiled to the first virtual registers, so pin them to keep the calling
	// convention intact.
	for (let i = 0; i < fn.parameterCount; ++i) {
		virtualRegisterToRealRegister.set(i, i);
		highestUsedRegister = i;
	}

	for (const block of orderedBlocks) {
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

				const rep = repOf(virtualRegister);
				const free = freeRegisters[rep];

				const mappedValue = virtualRegisterToRealRegister.get(virtualRegister);
				if (mappedValue !== undefined) {
					instruction.registers[i] = mappedValue;

					if (isFreeable(virtualRegister, instruction)) {
						// Free the register if this is the last use.
						free.push(mappedValue);
					}

					continue;
				}

				const isLastUse = isFreeable(virtualRegister, instruction);

				let mappedRegister: number;
				if (free.length > 0) {
					// Don't even claim it if it is the last use.
					mappedRegister = isLastUse ? free[0]! : free.pop()!;
				} else {
					mappedRegister = ++highestUsedRegister;
					if (isLastUse) {
						free.push(mappedRegister);
						free.sort((a, b) => a - b);
					}
				}

				instruction.registers[i] = mappedRegister;
				virtualRegisterToRealRegister.set(virtualRegister, mappedRegister);
			}
		}
	}

	fn.nextRegisterDestination = highestUsedRegister + 1;
}
