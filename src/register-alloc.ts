import { builtinOperationDescriptor } from "./builtin-registry.ts";
import {
	compilerFactIsWorldInvariant,
	knownBuiltinCallProves,
} from "./compiler-facts.ts";
import {
	buildIRRegisterIndex,
	definedRegisters,
	usedRegisters,
} from "./ir-register-index.ts";
import { debugIntermediateProgram } from "./ir.ts";
import type { IntermediateProgram, IRBlock, IRFunction, IRInstruction } from "./ir.ts";
import {
	applyInstructionSuccessorLiveness,
	computeRegisterLiveness,
	findBackEdges,
} from "./liveness.ts";
import { debugEnabled } from "./utils.ts";

export { definedRegister } from "./ir-register-index.ts";

/**
 * Optimize from virtual registers to VM registers.
 */
export function allocateRegisters(program: IntermediateProgram) {
	for (const fn of program.functions) {
		allocateRegistersForFunction(fn);
	}

	if (debugEnabled) debugIntermediateProgram(program);
}

/**
 * Linear, semantics-first allocation for interpreted development images.
 *
 * Every virtual register gets a distinct dense physical register, apart from
 * required parameter and argument-snapshot precolors. This avoids liveness,
 * interference, and representation analysis on the edit path. The resulting
 * frames are larger, but register identities cannot alias incorrectly and the
 * production allocator remains unchanged.
 */
export function allocateDevelopmentRegisters(program: IntermediateProgram): void {
	for (const fn of program.functions) {
		if (!developmentRegistersAlreadyValid(fn)) {
			allocateDense(fn, allVirtualRegisters(fn));
		}
	}

	if (debugEnabled) debugIntermediateProgram(program);
}

/**
 * IR destinations already live in one monotonically allocated namespace. The
 * development backend deliberately does not coalesce them, so rewriting every
 * operand through Map/Set tables is redundant unless argument snapshots need
 * their ABI-mandated dense prefix repaired.
 */
function developmentRegistersAlreadyValid(fn: IRFunction): boolean {
	let snapshotIndex = 0;
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			if (
				instruction.type !== "loadArgumentCount" &&
				instruction.type !== "loadArgument"
			) {
				return true;
			}
			if (instruction.registers[0] !== fn.parameterCount + snapshotIndex++) {
				return false;
			}
		}
	}
	return true;
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
export type RegisterRep = "boxed" | "number" | "boolean";

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
 * The rep an IR instruction's result naturally has given current operand reps, or
 * null when an operand is still unknown (defer to a later fixpoint iteration).
 * Mirrors emit-c's `producedRep`: comparisons and `!` yield a boolean; native
 * arithmetic/bitwise/remainder over two numbers yields a number; numeric unary
 * operations over a number yield a number; everything else is boxed.
 */
function producedRep(
	instruction: IRInstruction,
	repOf: (register: number) => RegisterRep | null,
): RegisterRep | null {
	switch (instruction.type) {
		case "createNumber":
		case "createF64":
		case "mathUnaryNumber":
		case "mathBinaryNumber":
			return "number";
		case "createBoolean":
		case "typeofCompare":
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
			if (
				op === "-" ||
				op === "+" ||
				op === "~" ||
				op === "tonumeric" ||
				op === "increment" ||
				op === "decrement"
			) {
				const src = repOf(instruction.registers[1]);
				return src === null ? null : src === "number" ? "number" : "boxed";
			}
			return "boxed";
		}
		case "call": {
			const call = instruction.knownBuiltinCall;
			const descriptor =
				call === undefined ? undefined : builtinOperationDescriptor(call.operation);
			const arguments_ = instruction.registers.slice(3);
			if (
				call === undefined ||
				descriptor?.nativeNumberArity !== arguments_.length ||
				!knownBuiltinCallProves(call, call.operation) ||
				!compilerFactIsWorldInvariant(call.identity)
			) {
				return "boxed";
			}
			for (const argument of arguments_) {
				const rep = repOf(argument);
				if (rep === null) return null;
				if (rep !== "number") return "boxed";
			}
			return "number";
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

/**
 * Forward fixpoint over virtual registers (top = unknown, then {number, boolean},
 * bottom = boxed): a register's rep is the join of the reps its definitions
 * produce. `producedRep` depends on operand reps, so iterate to a fixpoint; reps
 * only move down the lattice, so it converges. Parameters hold boxed incoming
 * arguments, so they start (and stay) `boxed`; a register never resolved (only
 * ever unwritten) defaults to `boxed`.
 */
export function inferVirtualReps(
	fn: IRFunction,
	speculativeNumberParameters: ReadonlySet<number> = new Set(),
): Map<number, RegisterRep> {
	const reps = new Map<number, RegisterRep | null>();
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			if (!("registers" in instruction)) {
				continue;
			}
			for (const register of instruction.registers) {
				if (register >= 0 && !reps.has(register)) {
					reps.set(
						register,
						register < fn.parameterCount
							? speculativeNumberParameters.has(register)
								? "number"
								: "boxed"
							: null,
					);
				}
			}
		}
	}

	const repOf = (register: number): RegisterRep | null =>
		reps.has(register) ? reps.get(register)! : "boxed";

	let changed = true;
	while (changed) {
		changed = false;
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				const produced = producedRep(instruction, repOf);
				// An operand still unknown: leave for a later iteration.
				if (produced === null) {
					continue;
				}
				for (const dst of definedRegisters(instruction)) {
					if (dst < fn.parameterCount) continue;
					const joined = joinReps(reps.get(dst) ?? null, produced);
					if (joined !== reps.get(dst)) {
						reps.set(dst, joined);
						changed = true;
					}
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

const INTERFERENCE_COMPLEXITY_LIMIT = 1_000_000;

function allVirtualRegisters(fn: IRFunction): Array<number> {
	const registers = new Set<number>();
	for (let register = 0; register < fn.parameterCount; register++)
		registers.add(register);
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			if (!("registers" in instruction)) continue;
			for (const register of instruction.registers) {
				if (register >= 0) registers.add(register);
			}
		}
	}
	return [...registers].sort((a, b) => a - b);
}

/** Entry snapshots must remain a dense physical range immediately after parameters. */
function argumentSnapshotPrecolors(fn: IRFunction): Map<number, number> {
	const precolors = new Map<number, number>();
	let snapshotIndex = 0;
	let scanningSnapshots = true;
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			if (
				instruction.type !== "loadArgumentCount" &&
				instruction.type !== "loadArgument"
			) {
				scanningSnapshots = false;
				break;
			}
			const register = instruction.registers[0];
			const color = fn.parameterCount + snapshotIndex++;
			const existing = precolors.get(register);
			if (existing !== undefined && existing !== color) {
				throw new Error("Argument snapshot register has conflicting destinations");
			}
			precolors.set(register, color);
		}
		if (!scanningSnapshots) break;
	}
	return precolors;
}

function basePrecolors(fn: IRFunction): Map<number, number> {
	const precolors = argumentSnapshotPrecolors(fn);
	for (let register = 0; register < fn.parameterCount; register++) {
		const existing = precolors.get(register);
		if (existing !== undefined && existing !== register) {
			throw new Error("Argument snapshot destination aliases a parameter register");
		}
		precolors.set(register, register);
	}
	return precolors;
}

function rewriteRegisters(fn: IRFunction, colors: ReadonlyMap<number, number>): void {
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			if (!("registers" in instruction)) continue;
			for (let position = 0; position < instruction.registers.length; position++) {
				const register = instruction.registers[position]!;
				if (register < 0) continue;
				const color = colors.get(register);
				if (color === undefined)
					throw new Error(`Unallocated virtual register ${register}`);
				instruction.registers[position] = color;
			}
		}
	}
}

function registerCountForColors(colors: Iterable<number>): number {
	let highest = -1;
	for (const color of colors) highest = Math.max(highest, color);
	return highest + 1;
}

/** No-coalescing fallback that still compacts sparse virtual numbering safely. */
function allocateDense(fn: IRFunction, registers: ReadonlyArray<number>): void {
	const colors = basePrecolors(fn);
	const occupied = new Set(colors.values());
	let nextColor = 0;
	for (const register of registers) {
		if (colors.has(register)) continue;
		while (occupied.has(nextColor)) nextColor++;
		colors.set(register, nextColor);
		occupied.add(nextColor);
	}
	rewriteRegisters(fn, colors);
	fn.nextRegisterDestination = registerCountForColors(occupied);
}

function interferenceComplexityIsHigh(fn: IRFunction, registerCount: number): boolean {
	let estimate = 0;
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			if (!("registers" in instruction)) continue;
			const operands = new Set(instruction.registers.filter((register) => register >= 0));
			const definitions = definedRegisters(instruction).length;
			estimate += (operands.size * (operands.size - 1)) / 2;
			estimate += definitions * registerCount;
			if (!Number.isSafeInteger(estimate) || estimate > INTERFERENCE_COMPLEXITY_LIMIT) {
				return true;
			}
		}
	}
	return false;
}

function allocateWithInterference(
	fn: IRFunction,
	virtualReps: ReadonlyMap<number, RegisterRep>,
): void {
	const registers = allVirtualRegisters(fn);
	if (interferenceComplexityIsHigh(fn, registers.length)) {
		allocateDense(fn, registers);
		return;
	}

	const liveness = computeRegisterLiveness(fn);
	if (liveness.usedFallback) {
		allocateDense(fn, registers);
		return;
	}

	const repOf = (register: number): RegisterRep => virtualReps.get(register) ?? "boxed";
	const graph = new Map<number, Set<number>>(
		registers.map((register) => [register, new Set<number>()]),
	);
	const addEdge = (left: number, right: number): void => {
		if (left === right || repOf(left) !== repOf(right)) return;
		graph.get(left)!.add(right);
		graph.get(right)!.add(left);
	};
	const addClique = (values: Iterable<number>): void => {
		const distinct = [...new Set(values)];
		for (let left = 0; left < distinct.length; left++) {
			for (let right = left + 1; right < distinct.length; right++) {
				addEdge(distinct[left]!, distinct[right]!);
			}
		}
	};

	for (let blockIndex = 0; blockIndex < fn.blocks.length; blockIndex++) {
		const live = new Set(liveness.liveOutByBlock[blockIndex]);
		const instructions = fn.blocks[blockIndex]!.instructions;
		for (
			let instructionIndex = instructions.length - 1;
			instructionIndex >= 0;
			--instructionIndex
		) {
			const instruction = instructions[instructionIndex]!;
			applyInstructionSuccessorLiveness(instruction, live, liveness.liveInByBlock);
			const definitions = definedRegisters(instruction);
			const uses = usedRegisters(instruction);
			const handler = liveness.handlerByInstruction[blockIndex]![instructionIndex];
			const liveAcross = new Set(live);
			if (handler !== null && handler !== undefined) {
				for (const register of liveness.liveInByBlock[handler]!) liveAcross.add(register);
			}

			// VM instructions may not support destructive source/destination aliases.
			// Distinct sources and simultaneous destinations must also remain distinct.
			addClique([...definitions, ...uses]);
			for (const definition of definitions) {
				for (const register of liveAcross) addEdge(definition, register);
			}

			for (const definition of definitions) live.delete(definition);
			if (handler !== null && handler !== undefined) {
				for (const register of liveness.liveInByBlock[handler]!) live.add(register);
			}
			for (const use of uses) live.add(use);
		}
	}

	const colors = basePrecolors(fn);
	const colorReps = new Map<number, RegisterRep>();
	for (const [register, color] of colors) {
		const rep = repOf(register);
		const existing = colorReps.get(color);
		if (existing !== undefined && existing !== rep) {
			throw new Error(`Precolored register ${color} has incompatible representations`);
		}
		colorReps.set(color, rep);
	}
	const reservedColors = new Set<number>();
	for (let color = 0; color < fn.parameterCount; color++) reservedColors.add(color);

	const ordered = registers
		.filter((register) => !colors.has(register))
		.sort((left, right) => {
			const degree = graph.get(right)!.size - graph.get(left)!.size;
			return degree !== 0 ? degree : left - right;
		});
	for (const register of ordered) {
		const rep = repOf(register);
		const forbidden = new Set<number>();
		for (const neighbor of graph.get(register)!) {
			const color = colors.get(neighbor);
			if (color !== undefined) forbidden.add(color);
		}

		let color = 0;
		while (
			reservedColors.has(color) ||
			forbidden.has(color) ||
			(colorReps.has(color) && colorReps.get(color) !== rep)
		) {
			color++;
		}
		colors.set(register, color);
		colorReps.set(color, rep);
	}

	rewriteRegisters(fn, colors);
	fn.nextRegisterDestination = registerCountForColors(colorReps.keys());
}

/**
 * Parameters used as stable Number leaves by a finite construction already have
 * an explicit guarded fast version in the C backend. Recover the originating
 * parameter through single-definition MOVEs so allocation can keep that
 * version's numeric values out of physical registers later reused by objects.
 *
 * This does not change the VM representation or remove the boxed version: it is
 * only an allocation partition. The emitted entry guard still selects between
 * the native-number and fully generic bodies at runtime.
 */
function finiteConstructionNumberParameters(fn: IRFunction): Set<number> {
	const parameters = new Set<number>();
	const index = buildIRRegisterIndex(fn);
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			if (
				instruction.type !== "createObject" ||
				instruction.nativeFiniteConstruction === undefined
			) {
				continue;
			}
			for (const guard of instruction.registers.slice(1)) {
				let register = guard;
				const seen = new Set<number>();
				while (!seen.has(register)) {
					seen.add(register);
					if (register < fn.parameterCount) {
						parameters.add(register);
						break;
					}
					const definition = index.uniqueDefinitions.get(register);
					if (definition?.type !== "move") break;
					register = definition.registers[1];
				}
			}
		}
	}
	return parameters;
}

/**
 * Allocate registers for a function. Rep-aware: a freed physical register is
 * only reused for a virtual register of the same representation, so each
 * physical register holds a single rep across its life. That lets the native
 * backend keep `number` registers unboxed (in C doubles) instead of having a
 * boolean/object/argument poison a register it shares.
 */
function allocateRegistersForFunction(fn: IRFunction) {
	// The single-definition path below depends on definitions preceding uses. The
	// interference path uses CFG liveness and does not depend on this order.
	const orderedBlocks = reversePostorderBlocks(fn);

	// Use referential equality to track last use of virtual registers
	const registerLastUsedIn = new Map<number, IRInstruction>();
	const registerUsedInMultipleBlocks = new Map<number, Set<IRBlock>>();
	const registerDefinitionCounts = new Map<number, number>();

	for (const block of orderedBlocks) {
		for (const instruction of block.instructions) {
			for (const defined of definedRegisters(instruction)) {
				registerDefinitionCounts.set(
					defined,
					(registerDefinitionCounts.get(defined) ?? 0) + 1,
				);
			}
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

	const speculativeNumberParameters = finiteConstructionNumberParameters(fn);
	const virtualReps = inferVirtualReps(fn, speculativeNumberParameters);
	const hasMultipleDefinitions = [...registerDefinitionCounts.values()].some(
		(count) => count > 1,
	);
	const hasBackEdge = findBackEdges(fn).backEdges.length > 0;
	if (hasMultipleDefinitions || hasBackEdge) {
		allocateWithInterference(fn, virtualReps);
		return;
	}

	const repOf = (register: number): RegisterRep => virtualReps.get(register) ?? "boxed";

	const virtualRegisterToRealRegister = new Map<number, number>();
	const freeRegisters: Record<RegisterRep, Array<number>> = {
		boxed: [],
		number: [],
		boolean: [],
	};
	let highestUsedRegister = -1;

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
			const freeAfterInstruction: Record<RegisterRep, Set<number>> = {
				boxed: new Set(),
				number: new Set(),
				boolean: new Set(),
			};

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
						freeAfterInstruction[rep].add(mappedValue);
					}

					continue;
				}

				let mappedRegister: number;
				if (free.length > 0) {
					mappedRegister = free.pop()!;
				} else {
					mappedRegister = ++highestUsedRegister;
				}

				instruction.registers[i] = mappedRegister;
				virtualRegisterToRealRegister.set(virtualRegister, mappedRegister);
				if (isFreeable(virtualRegister, instruction)) {
					freeAfterInstruction[rep].add(mappedRegister);
				}
			}

			for (const rep of ["boxed", "number", "boolean"] as const) {
				freeRegisters[rep].push(...freeAfterInstruction[rep]);
			}
		}
	}

	fn.nextRegisterDestination = highestUsedRegister + 1;
}
