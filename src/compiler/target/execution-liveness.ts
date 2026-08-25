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
		if (instruction.type !== "sourcePos" && instruction.type !== "tryEnd") {
			return instruction;
		}
	}
	return undefined;
}

function fallsThrough(instructions: ReadonlyArray<CompilerInstruction>): boolean {
	const last = lastExecutable(instructions);
	return last === undefined || !BLOCK_TERMINATORS.has(last.type);
}

function sameRegisters(left: ReadonlySet<number>, right: ReadonlySet<number>): boolean {
	if (left.size !== right.size) return false;
	for (const register of left) {
		if (!right.has(register)) return false;
	}
	return true;
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
	const operands: Array<Array<BoxedOperands>> = fn.blocks.map(({ instructions }) =>
		instructions.map((instruction) => {
			const registers = instructionRegisters(instruction);
			const writes = writeCount(instruction);
			return {
				reads: registers
					.slice(writes)
					.filter(
						(register) =>
							register >= 0 && fn.registerRepresentations[register] === "boxed",
					),
				writes: registers
					.slice(0, writes)
					.filter(
						(register) =>
							register >= 0 && fn.registerRepresentations[register] === "boxed",
					),
			};
		}),
	);
	const successors = blockSuccessors(fn);
	const transfer = (block: number, out: ReadonlySet<number>): Set<number> => {
		const live = new Set(out);
		for (let index = operands[block]!.length - 1; index >= 0; index--) {
			for (const register of operands[block]![index]!.writes) live.delete(register);
			for (const register of operands[block]![index]!.reads) live.add(register);
		}
		return live;
	};
	const liveIn: Array<Set<number>> = fn.blocks.map(() => new Set<number>());
	let changed = true;
	while (changed) {
		changed = false;
		for (let block = fn.blocks.length - 1; block >= 0; block--) {
			const out = new Set<number>();
			for (const successor of successors[block]!) {
				for (const register of liveIn[successor]!) out.add(register);
			}
			const live = transfer(block, out);
			if (!sameRegisters(live, liveIn[block]!)) {
				liveIn[block] = live;
				changed = true;
			}
		}
	}

	const roots = new Map<CompilerInstruction, ReadonlyArray<number>>();
	for (const [block, { instructions }] of fn.blocks.entries()) {
		const live = new Set<number>();
		for (const successor of successors[block]!) {
			for (const register of liveIn[successor]!) live.add(register);
		}
		for (let index = instructions.length - 1; index >= 0; index--) {
			const instruction = instructions[index]!;
			const instructionOperands = operands[block]![index]!;
			if (safepoints.has(instruction)) {
				roots.set(
					instruction,
					[...new Set([...live, ...instructionOperands.reads])].sort(
						(left, right) => left - right,
					),
				);
			}
			for (const register of instructionOperands.writes) live.delete(register);
			for (const register of instructionOperands.reads) live.add(register);
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
