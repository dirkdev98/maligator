import type { CoreInstructionId, CoreOpcodeId } from "./core-ir.ts";

export class CoreFunctionOpcodeSites {
	readonly #first = new Array<number | undefined>();
	readonly #next: Uint32Array;
	readonly #opcodes: Array<CoreOpcodeId> = [];

	constructor(instructionOpcodes: ReadonlyArray<number>) {
		this.#next = new Uint32Array(instructionOpcodes.length);
		for (
			let instruction = instructionOpcodes.length - 1;
			instruction >= 0;
			instruction--
		) {
			const opcode = instructionOpcodes[instruction]!;
			if (opcode < 0) continue;
			const next = this.#first[opcode];
			if (next === undefined) this.#opcodes.push(opcode as CoreOpcodeId);
			else this.#next[instruction] = next + 1;
			this.#first[opcode] = instruction;
		}
	}

	get opcodes(): ReadonlyArray<CoreOpcodeId> {
		return this.#opcodes;
	}

	hasAny(opcodes: ArrayLike<number>): boolean {
		for (let index = 0; index < opcodes.length; index++)
			if (this.#first[opcodes[index]!] !== undefined) return true;
		return false;
	}

	instructions(opcodes: ReadonlyArray<CoreOpcodeId>): Array<CoreInstructionId> {
		const result: Array<CoreInstructionId> = [];
		for (const opcode of opcodes) {
			for (let site = this.#first[opcode] ?? -1; site >= 0; site = this.#next[site]! - 1)
				result.push(site as CoreInstructionId);
		}
		// Passes choose candidates in instruction ID order across opcode families.
		if (opcodes.length > 1) result.sort((left, right) => left - right);
		return result;
	}
}
