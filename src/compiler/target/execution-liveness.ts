import { coreOpcodeRegistry, isCoreOpcode } from "../core/core-ir-opcodes.ts";
import type { CompilerInstruction } from "../shared/compiler-instruction.ts";
import type { ExecutionFunction } from "./execution-ir.ts";

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
 * The set includes operands used while the operation can collect and values live
 * immediately afterwards (including a result observed by a call-return poll).
 */
export function executionSafepointRootRegisters(
	fn: ExecutionFunction,
	safepoints: ReadonlySet<CompilerInstruction>,
): ReadonlyMap<CompilerInstruction, ReadonlyArray<number>> {
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
	const operands: Array<Array<BoxedOperands>> = fn.blocks.map(({ instructions }) =>
		instructions.map((instruction) => {
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
	const transfer = (block: number, out: Uint32Array): Uint32Array => {
		const live = out.slice();
		for (let index = operands[block]!.length - 1; index >= 0; index--) {
			for (const register of operands[block]![index]!.writes) remove(live, register);
			for (const register of operands[block]![index]!.reads) add(live, register);
		}
		return live;
	};
	const liveIn: Array<Uint32Array> = fn.blocks.map(() => new Uint32Array(wordCount));
	const worklist = fn.blocks.map((_, block) => block);
	const queued = new Uint8Array(fn.blocks.length).fill(1);
	while (worklist.length > 0) {
		const block = worklist.pop()!;
		queued[block] = 0;
		const out = new Uint32Array(wordCount);
		for (const successor of successors[block]!) {
			unionInto(out, liveIn[successor]!);
		}
		const live = transfer(block, out);
		if (sameRegisters(live, liveIn[block]!)) continue;
		liveIn[block] = live;
		for (const predecessor of predecessors[block]!) {
			if (queued[predecessor] !== 0) continue;
			queued[predecessor] = 1;
			worklist.push(predecessor);
		}
	}

	const roots = new Map<CompilerInstruction, ReadonlyArray<number>>();
	for (const [block, { instructions }] of fn.blocks.entries()) {
		const live = new Uint32Array(wordCount);
		for (const successor of successors[block]!) {
			unionInto(live, liveIn[successor]!);
		}
		for (let index = instructions.length - 1; index >= 0; index--) {
			const instruction = instructions[index]!;
			const instructionOperands = operands[block]![index]!;
			if (safepoints.has(instruction)) {
				const atSafepoint = live.slice();
				for (const register of instructionOperands.reads) add(atSafepoint, register);
				for (const register of instructionOperands.writes) add(atSafepoint, register);
				roots.set(instruction, rootRegisters(atSafepoint));
			}
			for (const register of instructionOperands.writes) remove(live, register);
			for (const register of instructionOperands.reads) add(live, register);
		}
	}
	return roots;
}

/** Native C polls exactly on transfers whose flattened target IP is not forward. */
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
