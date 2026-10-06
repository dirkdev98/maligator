import { coreOpcodeRegistry, isCoreOpcode } from "../core/core-ir-opcodes.ts";
import type { CompilerInstruction } from "../shared/compiler-instruction.ts";
import type { ExecutionFunction, ExecutionSafepointRoots } from "./execution-ir.ts";

const STRUCTURAL_WRITE_COUNTS: Readonly<Record<string, number>> = {
	sourcePos: 0,
	jump: 0,
	jumpIf: 0,
	tryBegin: 0,
	tryEnd: 0,
	catch: 1,
	return: 0,
	throw: 0,
};

const BLOCK_TERMINATORS: ReadonlySet<string> = new Set(["jump", "return", "throw"]);

function instructionRegisters(instruction: CompilerInstruction): ReadonlyArray<number> {
	return (instruction as { readonly registers?: ReadonlyArray<number> }).registers ?? [];
}

function writeCount(instruction: CompilerInstruction): number {
	const structural = STRUCTURAL_WRITE_COUNTS[instruction.type];
	if (structural !== undefined) return structural;
	if (!isCoreOpcode(instruction.type)) {
		throw new Error(`Unknown execution instruction ${instruction.type}`);
	}
	const descriptor = coreOpcodeRegistry.require(instruction.type);
	if (descriptor.outputs.minimum !== descriptor.outputs.maximum) {
		throw new Error(`Execution instruction ${instruction.type} has variable outputs`);
	}
	return descriptor.outputs.minimum;
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

interface BoxedOperands {
	readonly reads: ReadonlyArray<number>;
	readonly writes: ReadonlyArray<number>;
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
	if (safepoints.size === 0) return new Map();
	const wordCount = Math.ceil(fn.registerCount / 32);
	const add = (registers: Uint32Array, register: number): void => {
		registers[register >>> 5]! |= 1 << (register & 31);
	};
	const remove = (registers: Uint32Array, register: number): void => {
		registers[register >>> 5]! &= ~(1 << (register & 31));
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
	const firstSafepoints = new Int32Array(fn.blocks.length).fill(-1);
	const operands: Array<Array<BoxedOperands>> = fn.blocks.map(({ instructions }, block) =>
		instructions.map((instruction, index) => {
			if (firstSafepoints[block] === -1 && safepoints.has(instruction)) {
				firstSafepoints[block] = index;
			}
			const registers = instructionRegisters(instruction);
			const writes = writeCount(instruction);
			const rooted = (register: number): boolean => {
				const representation = fn.registerRepresentations[register];
				return representation === "boxed" || representation === "string";
			};
			return {
				reads: registers
					.slice(writes)
					.filter((register) => register >= 0 && rooted(register)),
				writes: registers
					.slice(0, writes)
					.filter((register) => register >= 0 && rooted(register)),
			};
		}),
	);
	const successors = blockSuccessors(fn);
	const predecessors: Array<Array<number>> = fn.blocks.map(() => []);
	for (const [block, targets] of successors.entries()) {
		for (const target of targets) predecessors[target]!.push(block);
	}
	const transfers = operands.map((instructions) => {
		const generated = new Uint32Array(wordCount);
		const killed = new Uint32Array(wordCount);
		for (let index = instructions.length - 1; index >= 0; index--) {
			for (const register of instructions[index]!.writes) {
				remove(generated, register);
				add(killed, register);
			}
			for (const register of instructions[index]!.reads) add(generated, register);
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

	const roots = new Map<CompilerInstruction, ExecutionSafepointRoots>();
	const incoming = new Uint32Array(wordCount);
	const outgoing = new Uint32Array(wordCount);
	const combined = new Uint32Array(wordCount);
	for (const [block, { instructions }] of fn.blocks.entries()) {
		const firstSafepoint = firstSafepoints[block]!;
		if (firstSafepoint < 0) continue;
		const live = new Uint32Array(wordCount);
		for (const successor of successors[block]!) {
			unionInto(live, liveIn[successor]!);
		}
		for (let index = instructions.length - 1; index >= firstSafepoint; index--) {
			const instruction = instructions[index]!;
			const instructionOperands = operands[block]![index]!;
			if (safepoints.has(instruction)) {
				incoming.set(live);
				for (const register of instructionOperands.writes) remove(incoming, register);
				for (const register of instructionOperands.reads) add(incoming, register);
				outgoing.set(live);
				for (const register of instructionOperands.writes) add(outgoing, register);
				combined.set(incoming);
				unionInto(combined, outgoing);
				roots.set(instruction, {
					rootRegisters: rootRegisters(combined),
					incomingRootRegisters: rootRegisters(incoming),
					outgoingRootRegisters: rootRegisters(outgoing),
				});
			}
			for (const register of instructionOperands.writes) remove(live, register);
			for (const register of instructionOperands.reads) add(live, register);
		}
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
