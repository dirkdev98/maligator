import type { CompilerInstruction } from "../shared/compiler-instruction.ts";
import type { ExecutionFunction, ExecutionSafepointRoots } from "./execution-ir.ts";
import { executionOperandShape } from "./execution-operand-shapes.ts";

const BLOCK_TERMINATORS: ReadonlySet<string> = new Set(["jump", "return", "throw"]);

function instructionRegisters(instruction: CompilerInstruction): ReadonlyArray<number> {
	return (instruction as { readonly registers?: ReadonlyArray<number> }).registers ?? [];
}

function writeCount(instruction: CompilerInstruction): number {
	const shape = executionOperandShape(instruction.type);
	if (shape === undefined)
		throw new Error(`Unknown execution instruction ${instruction.type}`);
	if (shape === "variable-outputs")
		throw new Error(`Execution instruction ${instruction.type} has variable outputs`);
	return shape.writes;
}

function lastExecutable(
	instructions: ReadonlyArray<CompilerInstruction>,
): CompilerInstruction | undefined {
	for (let index = instructions.length - 1; index >= 0; index--) {
		const instruction = instructions[index]!;
		if (
			instruction.type !== "sourcePos" &&
			instruction.type !== "rootUse" &&
			instruction.type !== "tryEnd"
		) {
			return instruction;
		}
	}
	return undefined;
}

function fallsThrough(instructions: ReadonlyArray<CompilerInstruction>): boolean {
	const last = lastExecutable(instructions);
	return last === undefined || !BLOCK_TERMINATORS.has(last.type);
}

function blockSuccessors(fn: ExecutionFunction): ReadonlyArray<ReadonlyArray<number>> {
	return fn.blocks.map(({ instructions }, block) => {
		const successors = new Set<number>();
		for (const instruction of instructions) {
			if (
				instruction.type === "jump" ||
				instruction.type === "jumpIf" ||
				instruction.type === "tryBegin"
			) {
				successors.add(instruction.blocks[0]);
			}
		}
		if (fallsThrough(instructions) && block + 1 < fn.blocks.length) {
			successors.add(block + 1);
		}
		return [...successors];
	});
}

/**
 * Exact boxed physical-register obligations at selected execution instructions.
 * Incoming and outgoing sets separate values present before the operation from
 * its returned values. The union supports continuously rooted register storage.
 */
export function executionSafepointRoots(
	fn: ExecutionFunction,
	safepoints: ReadonlySet<CompilerInstruction>,
): ReadonlyMap<CompilerInstruction, ExecutionSafepointRoots> {
	const roots = new Map<CompilerInstruction, ExecutionSafepointRoots>();
	solveSafepointRoots(fn, safepoints, roots);
	return roots;
}

type SafepointSelection = Pick<ReadonlySet<CompilerInstruction>, "has" | "size">;
type RootBitmapVisitor = (
	instruction: CompilerInstruction,
	boundary: keyof ExecutionSafepointRoots,
	words: number | ArrayLike<number>,
) => void;

// Multiword storage belongs to the solve and is valid only during each visit.
export function visitExecutionSafepointRoots(
	fn: ExecutionFunction,
	safepoints: SafepointSelection,
	visit: RootBitmapVisitor,
): void {
	solveSafepointRoots(fn, safepoints, undefined, visit);
}

function solveSafepointRoots(
	fn: ExecutionFunction,
	safepoints: SafepointSelection,
	roots: Map<CompilerInstruction, ExecutionSafepointRoots> | undefined,
	visit?: RootBitmapVisitor,
): void {
	if (safepoints.size === 0) return;
	const successors = blockSuccessors(fn);
	const predecessors: Array<Array<number>> = fn.blocks.map(() => []);
	for (const [block, targets] of successors.entries()) {
		for (const target of targets) predecessors[target]!.push(block);
	}
	const blockStarts = new Uint32Array(fn.blocks.length + 1);
	for (let block = 0; block < fn.blocks.length; block++)
		blockStarts[block + 1] = blockStarts[block]! + fn.blocks[block]!.instructions.length;
	const firstSafepoints = new Int32Array(fn.blocks.length).fill(-1);
	if (fn.registerCount <= 32)
		return singleWordSafepointRoots(
			fn,
			safepoints,
			blockStarts,
			firstSafepoints,
			successors,
			predecessors,
			roots,
			visit,
		);
	const wordCount = Math.ceil(fn.registerCount / 32);
	// Each span starts with its boxed write count, followed by writes and reads.
	const operands: Array<number> = [];
	const operandStarts = new Uint32Array(blockStarts[fn.blocks.length]! + 1);
	for (let block = 0; block < fn.blocks.length; block++) {
		const { instructions } = fn.blocks[block]!;
		for (let index = 0; index < instructions.length; index++) {
			const instruction = instructions[index]!;
			if (firstSafepoints[block] === -1 && safepoints.has(instruction))
				firstSafepoints[block] = index;
			const registers = instructionRegisters(instruction);
			const outputCount = writeCount(instruction);
			const start = operands.length;
			operandStarts[blockStarts[block]! + index] = start;
			operands.push(0);
			for (let operand = 0; operand < registers.length; operand++) {
				const register = registers[operand]!;
				if (!(register >= 0)) continue;
				const representation = fn.registerRepresentations[register];
				if (representation !== "boxed" && representation !== "string") continue;
				operands.push(register);
				if (operand < outputCount) operands[start]!++;
			}
		}
	}
	operandStarts[operandStarts.length - 1] = operands.length;
	const add = (registers: Uint32Array, register: number): boolean => {
		const word = register >>> 5;
		const previous = registers[word]!;
		const next = (previous | (1 << (register & 31))) >>> 0;
		registers[word] = next;
		return previous !== next;
	};
	const remove = (registers: Uint32Array, register: number): boolean => {
		const word = register >>> 5;
		const previous = registers[word]!;
		const next = (previous & ~(1 << (register & 31))) >>> 0;
		registers[word] = next;
		return previous !== next;
	};
	const unionInto = (target: Uint32Array, source: Uint32Array): void => {
		for (let word = 0; word < wordCount; word++) target[word]! |= source[word]!;
	};
	const sameRegisters = (left: Uint32Array, right: Uint32Array): boolean => {
		for (let word = 0; word < wordCount; word++) {
			if (left[word] !== right[word]) return false;
		}
		return true;
	};
	const rootRegisters = (registers: Uint32Array): Array<number> => {
		const roots: Array<number> = [];
		for (let word = 0; word < wordCount; word++) {
			let bits = registers[word]!;
			while (bits !== 0) {
				const bit = 31 - Math.clz32(bits & -bits);
				roots.push(word * 32 + bit);
				bits &= bits - 1;
			}
		}
		return roots;
	};
	const transfers = fn.blocks.map((_, block) => {
		const generated = new Uint32Array(wordCount);
		const killed = new Uint32Array(wordCount);
		for (let index = blockStarts[block + 1]! - 1; index >= blockStarts[block]!; index--) {
			const start = operandStarts[index]!;
			const writeEnd = start + 1 + operands[start]!;
			const end = operandStarts[index + 1]!;
			for (let operand = start + 1; operand < writeEnd; operand++) {
				const register = operands[operand]!;
				remove(generated, register);
				add(killed, register);
			}
			for (let operand = writeEnd; operand < end; operand++)
				add(generated, operands[operand]!);
		}
		return { generated, killed };
	});
	const transfer = (block: number, out: Uint32Array): Uint32Array => {
		const { generated, killed } = transfers[block]!;
		// The scratch buffer never aliases a published live-in set, including self-loops.
		for (let word = 0; word < wordCount; word++) {
			out[word] = (out[word]! & ~killed[word]!) | generated[word]!;
		}
		return out;
	};
	const liveIn: Array<Uint32Array> = fn.blocks.map(() => new Uint32Array(wordCount));
	const worklist = fn.blocks.map((_, block) => block);
	const queued = new Uint8Array(fn.blocks.length).fill(1);
	let scratch: Uint32Array = new Uint32Array(wordCount);
	while (worklist.length > 0) {
		const block = worklist.pop()!;
		queued[block] = 0;
		const out = scratch;
		out.fill(0);
		for (const successor of successors[block]!) {
			unionInto(out, liveIn[successor]!);
		}
		const live = transfer(block, out);
		if (sameRegisters(live, liveIn[block]!)) continue;
		scratch = liveIn[block]!;
		liveIn[block] = live;
		for (const predecessor of predecessors[block]!) {
			if (queued[predecessor] !== 0) continue;
			queued[predecessor] = 1;
			worklist.push(predecessor);
		}
	}

	for (const [block, { instructions }] of fn.blocks.entries()) {
		const firstSafepoint = firstSafepoints[block]!;
		if (firstSafepoint < 0) continue;
		const live = scratch;
		live.fill(0);
		for (const successor of successors[block]!) {
			unionInto(live, liveIn[successor]!);
		}
		let materialized: ReadonlyArray<number> | undefined;
		const snapshot = () => (materialized ??= rootRegisters(live));
		for (let index = instructions.length - 1; index >= firstSafepoint; index--) {
			const instruction = instructions[index]!;
			const row = blockStarts[block]! + index;
			const start = operandStarts[row]!;
			const writeEnd = start + 1 + operands[start]!;
			const end = operandStarts[row + 1]!;
			let outgoingRootRegisters: ReadonlyArray<number> | undefined;
			let allRootRegisters: ReadonlyArray<number> | undefined;
			const selected = safepoints.has(instruction);
			if (selected) {
				for (let operand = start + 1; operand < writeEnd; operand++) {
					if (add(live, operands[operand]!)) materialized = undefined;
				}
				if (visit === undefined) outgoingRootRegisters = snapshot();
				else visit(instruction, "outgoingRootRegisters", live);
				for (let operand = writeEnd; operand < end; operand++) {
					if (add(live, operands[operand]!)) materialized = undefined;
				}
				if (visit === undefined) allRootRegisters = snapshot();
				else visit(instruction, "rootRegisters", live);
			}
			// Killing writes also removes the outputs added for the outgoing/combined snapshots.
			for (let operand = start + 1; operand < writeEnd; operand++) {
				if (remove(live, operands[operand]!)) materialized = undefined;
			}
			for (let operand = writeEnd; operand < end; operand++) {
				if (add(live, operands[operand]!)) materialized = undefined;
			}
			if (selected && visit !== undefined)
				visit(instruction, "incomingRootRegisters", live);
			else if (allRootRegisters !== undefined && outgoingRootRegisters !== undefined) {
				roots!.set(instruction, {
					rootRegisters: allRootRegisters,
					incomingRootRegisters: snapshot(),
					outgoingRootRegisters,
				});
			}
		}
	}
}

// A one-word transfer can compose directly from the operand masks. Reads occur
// before writes, including when a two-address instruction uses its destination.
function singleWordSafepointRoots(
	fn: ExecutionFunction,
	safepoints: SafepointSelection,
	blockStarts: Uint32Array,
	firstSafepoints: Int32Array,
	successors: ReadonlyArray<ReadonlyArray<number>>,
	predecessors: ReadonlyArray<ReadonlyArray<number>>,
	roots: Map<CompilerInstruction, ExecutionSafepointRoots> | undefined,
	visit?: RootBitmapVisitor,
): void {
	const operandMasks = new Uint32Array(blockStarts[fn.blocks.length]! * 2);
	const generated = new Uint32Array(fn.blocks.length);
	const killed = new Uint32Array(fn.blocks.length);
	for (let block = 0; block < fn.blocks.length; block++) {
		let gen = 0;
		let kill = 0;
		const { instructions } = fn.blocks[block]!;
		for (let index = 0; index < instructions.length; index++) {
			const instruction = instructions[index]!;
			if (firstSafepoints[block] === -1 && safepoints.has(instruction))
				firstSafepoints[block] = index;
			const registers = instructionRegisters(instruction);
			const outputCount = writeCount(instruction);
			let defined = 0;
			let used = 0;
			for (let operand = 0; operand < registers.length; operand++) {
				const register = registers[operand]!;
				if (!(register >= 0)) continue;
				const representation = fn.registerRepresentations[register];
				if (representation !== "boxed" && representation !== "string") continue;
				const bit = 1 << register;
				if (operand < outputCount) defined |= bit;
				else used |= bit;
			}
			const row = (blockStarts[block]! + index) * 2;
			operandMasks[row] = defined;
			operandMasks[row + 1] = used;
			gen |= used & ~kill;
			kill |= defined;
		}
		generated[block] = gen;
		killed[block] = kill;
	}
	const liveIn = new Uint32Array(fn.blocks.length);
	const worklist = fn.blocks.map((_, block) => block);
	const queued = new Uint8Array(fn.blocks.length).fill(1);
	while (worklist.length > 0) {
		const block = worklist.pop()!;
		queued[block] = 0;
		let out = 0;
		for (const successor of successors[block]!) out |= liveIn[successor]!;
		const live = ((out & ~killed[block]!) | generated[block]!) >>> 0;
		if (live === liveIn[block]) continue;
		liveIn[block] = live;
		for (const predecessor of predecessors[block]!) {
			if (queued[predecessor] !== 0) continue;
			queued[predecessor] = 1;
			worklist.push(predecessor);
		}
	}
	for (const [block, { instructions }] of fn.blocks.entries()) {
		const first = firstSafepoints[block]!;
		if (first < 0) continue;
		let live = 0;
		for (const successor of successors[block]!) live |= liveIn[successor]!;
		live >>>= 0;
		let materialized: ReadonlyArray<number> | undefined;
		for (let index = instructions.length - 1; index >= first; index--) {
			const instruction = instructions[index]!;
			const row = (blockStarts[block]! + index) * 2;
			const defined = operandMasks[row]!;
			const used = operandMasks[row + 1]!;
			const selected = safepoints.has(instruction);
			let outgoing: ReadonlyArray<number> | undefined;
			let all: ReadonlyArray<number> | undefined;
			if (selected) {
				const written = (live | defined) >>> 0;
				if (written !== live) materialized = undefined;
				if (visit === undefined)
					outgoing = materialized ??= singleWordRootRegisters(written);
				else visit(instruction, "outgoingRootRegisters", written);
				const combined = (written | used) >>> 0;
				if (combined !== written) materialized = undefined;
				if (visit === undefined) all = materialized ??= singleWordRootRegisters(combined);
				else visit(instruction, "rootRegisters", combined);
				live = combined;
			}
			const incoming = ((live & ~defined) | used) >>> 0;
			if (incoming !== live) materialized = undefined;
			live = incoming;
			if (selected && visit !== undefined)
				visit(instruction, "incomingRootRegisters", live);
			else if (all !== undefined && outgoing !== undefined)
				roots!.set(instruction, {
					rootRegisters: all,
					incomingRootRegisters: (materialized ??= singleWordRootRegisters(live)),
					outgoingRootRegisters: outgoing,
				});
		}
	}
}

function singleWordRootRegisters(bits: number): Array<number> {
	const roots: Array<number> = [];
	while (bits !== 0) {
		roots.push(31 - Math.clz32(bits & -bits));
		bits &= bits - 1;
	}
	return roots;
}

/** The VM polls transfers whose flattened target IP is not forward. */
export function executionLoopBackedgeInstructions(
	fn: ExecutionFunction,
): ReadonlySet<CompilerInstruction> {
	const blockStartIps = new Map<number, number>();
	let nextIp = 0;
	for (const [block, { instructions }] of fn.blocks.entries()) {
		blockStartIps.set(block, nextIp);
		for (const instruction of instructions) {
			if (
				instruction.type !== "sourcePos" &&
				instruction.type !== "rootUse" &&
				instruction.type !== "tryBegin" &&
				instruction.type !== "tryEnd"
			) {
				nextIp++;
			}
		}
	}
	const backedges = new Set<CompilerInstruction>();
	let ip = 0;
	for (const { instructions } of fn.blocks) {
		for (const instruction of instructions) {
			if (
				instruction.type === "sourcePos" ||
				instruction.type === "rootUse" ||
				instruction.type === "tryBegin" ||
				instruction.type === "tryEnd"
			) {
				continue;
			}
			if (instruction.type === "jump" || instruction.type === "jumpIf") {
				const targetIp = blockStartIps.get(instruction.blocks[0]);
				if (targetIp !== undefined && targetIp <= ip) backedges.add(instruction);
			}
			ip++;
		}
	}
	return backedges;
}

export function nativeLoopBackedgeInstructions(
	fn: ExecutionFunction,
): ReadonlySet<CompilerInstruction> {
	const edges = fn.blocks.map(({ instructions }) => {
		if (fallsThrough(instructions))
			throw new Error("Native Core target blocks require explicit control transfers");
		return instructions.filter(
			(instruction) =>
				instruction.type === "jump" ||
				instruction.type === "jumpIf" ||
				instruction.type === "tryBegin",
		);
	});
	const state = new Uint8Array(edges.length);
	const nextEdge = new Uint32Array(edges.length);
	const incomingEdges = new Array<CompilerInstruction | undefined>(edges.length);
	const backedges = new Set<CompilerInstruction>();
	let restart: boolean;
	do {
		restart = false;
		state.fill(0);
		nextEdge.fill(0);
		incomingEdges.fill(undefined);
		for (let entry = 0; entry < edges.length && !restart; entry++) {
			if (state[entry] !== 0) continue;
			const stack = [entry];
			state[entry] = 1;
			while (stack.length > 0 && !restart) {
				const block = stack[stack.length - 1]!;
				const instruction = edges[block]![nextEdge[block]!];
				if (instruction === undefined) {
					state[block] = 2;
					stack.pop();
					continue;
				}
				nextEdge[block]!++;
				if (backedges.has(instruction)) continue;
				const target = instruction.blocks[0];
				if (state[target] === 1) {
					if (instruction.type !== "tryBegin") backedges.add(instruction);
					else {
						let pollingEdge: CompilerInstruction | undefined;
						for (let index = stack.length - 1; stack[index] !== target; index--) {
							const incoming = incomingEdges[stack[index]!]!;
							if (incoming.type !== "tryBegin") {
								pollingEdge = incoming;
								break;
							}
						}
						if (pollingEdge === undefined)
							throw new Error("Native exceptional cycle has no polling branch");
						backedges.add(pollingEdge);
						// Cutting a DFS tree edge invalidates the current ancestor/reachability state.
						restart = true;
					}
				} else if (state[target] === 0) {
					state[target] = 1;
					incomingEdges[target] = instruction;
					stack.push(target);
				}
			}
		}
	} while (restart);
	return backedges;
}
