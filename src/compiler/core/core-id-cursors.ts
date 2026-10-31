import type { CoreInstructionId, CoreValueId } from "./core-ir.ts";

// Store ID walks are cursors rather than generators: V8 never inlines a generator, so
// every step resumes a suspended frame and allocates an iterator result, while a small
// class `next` inlines into an optimized for-of loop, where its results are
// scalar-replaced. Each cursor reads the store one step at a time, so a walk observes
// the edits its loop body makes the same way a generator over the store did.

/** The store whose retirement ends every walk over its columns. */
export interface CoreCursorOwner {
	assertCurrentGeneration(): void;
}

const CURSOR_DONE = -1;
const CHAIN_START = -2;

// Both outcomes share one literal so a step result has a single allocation site, which
// V8's escape analysis needs to scalar-replace it.
function cursorStep<Id extends number>(id: number): IteratorResult<Id, undefined> {
	const done = id < 0;
	return { done, value: done ? undefined : id } as IteratorResult<Id, undefined>;
}

/** Walks the IDs whose live-flag column entry is 1, including IDs appended mid-walk. */
export class CoreLiveIdCursor<Id extends number> implements Iterator<Id, undefined> {
	readonly #owner: CoreCursorOwner;
	readonly #live: ReadonlyArray<number>;
	#id = 0;

	constructor(owner: CoreCursorOwner, live: ReadonlyArray<number>) {
		this.#owner = owner;
		this.#live = live;
	}

	[Symbol.iterator](): this {
		return this;
	}

	next(): IteratorResult<Id, undefined> {
		let found = CURSOR_DONE;
		let id = this.#id;
		if (id !== CURSOR_DONE) {
			const live = this.#live;
			while (id < live.length) {
				this.#owner.assertCurrentGeneration();
				if (live[id++] === 1) {
					found = id - 1;
					break;
				}
			}
			this.#id = found === CURSOR_DONE ? CURSOR_DONE : id;
		}
		return cursorStep(found);
	}
}

/** Walks the indexes of defined entries in a sparse table, including ones added mid-walk. */
export class CoreSlotCursor<Id extends number> implements Iterator<Id, undefined> {
	readonly #owner: CoreCursorOwner | undefined;
	readonly #slots: ReadonlyArray<unknown>;
	#id = 0;

	constructor(owner: CoreCursorOwner | undefined, slots: ReadonlyArray<unknown>) {
		this.#owner = owner;
		this.#slots = slots;
	}

	[Symbol.iterator](): this {
		return this;
	}

	next(): IteratorResult<Id, undefined> {
		let found = CURSOR_DONE;
		let id = this.#id;
		if (id !== CURSOR_DONE) {
			const slots = this.#slots;
			while (id < slots.length) {
				this.#owner?.assertCurrentGeneration();
				if (slots[id++] !== undefined) {
					found = id - 1;
					break;
				}
			}
			this.#id = found === CURSOR_DONE ? CURSOR_DONE : id;
		}
		return cursorStep(found);
	}
}

/**
 * Walks a block's instruction chain. The successor is read only when the walk moves
 * past an instruction, so insertions after it and removals of it are followed. With an
 * opcode column, instructions with a negative opcode (terminators) are skipped.
 */
export class CoreInstructionChainCursor implements Iterator<
	CoreInstructionId,
	undefined
> {
	readonly #owner: CoreCursorOwner;
	readonly #firstInstruction: ReadonlyArray<number>;
	readonly #nextInstruction: ReadonlyArray<number>;
	readonly #opcode: ReadonlyArray<number> | undefined;
	readonly #block: number;
	#at = CHAIN_START;

	constructor(
		owner: CoreCursorOwner,
		firstInstruction: ReadonlyArray<number>,
		nextInstruction: ReadonlyArray<number>,
		opcode: ReadonlyArray<number> | undefined,
		block: number,
	) {
		this.#owner = owner;
		this.#firstInstruction = firstInstruction;
		this.#nextInstruction = nextInstruction;
		this.#opcode = opcode;
		this.#block = block;
	}

	[Symbol.iterator](): this {
		return this;
	}

	next(): IteratorResult<CoreInstructionId, undefined> {
		let instruction = this.#at;
		if (instruction !== CURSOR_DONE) {
			const next = this.#nextInstruction;
			instruction =
				instruction === CHAIN_START
					? (this.#firstInstruction[this.#block] ?? CURSOR_DONE)
					: (next[instruction] ?? CURSOR_DONE);
			const opcode = this.#opcode;
			while (instruction >= 0) {
				this.#owner.assertCurrentGeneration();
				if (opcode === undefined || opcode[instruction]! >= 0) break;
				instruction = next[instruction] ?? CURSOR_DONE;
			}
			this.#at = instruction;
		}
		return cursorStep(instruction);
	}
}

/** Columns that define where each block's parameters and each instruction's results live. */
export interface CoreValueCursorColumns {
	readonly blockLive: ReadonlyArray<number>;
	readonly blockParameterStart: ReadonlyArray<number>;
	readonly blockParameterCount: ReadonlyArray<number>;
	readonly blockParameterValues: ReadonlyArray<CoreValueId>;
	readonly instructionLive: ReadonlyArray<number>;
	readonly instructionResultStart: ReadonlyArray<number>;
	readonly instructionResultCount: ReadonlyArray<number>;
	readonly results: ReadonlyArray<CoreValueId>;
}

/**
 * Walks the parameters of live blocks, then the results of live instructions, both in
 * ID order. An owner's value range is read when the walk reaches the owner.
 */
export class CoreValueCursor implements Iterator<CoreValueId, undefined> {
	readonly #owner: CoreCursorOwner;
	readonly #columns: CoreValueCursorColumns;
	#inResults = false;
	#done = false;
	#definer = -1;
	#start = 0;
	#count = 0;
	#index = 0;

	constructor(owner: CoreCursorOwner, columns: CoreValueCursorColumns) {
		this.#owner = owner;
		this.#columns = columns;
	}

	[Symbol.iterator](): this {
		return this;
	}

	next(): IteratorResult<CoreValueId, undefined> {
		let value = CURSOR_DONE;
		const columns = this.#columns;
		while (!this.#done) {
			if (this.#index < this.#count) {
				this.#owner.assertCurrentGeneration();
				value = (this.#inResults ? columns.results : columns.blockParameterValues)[
					this.#start + this.#index++
				]!;
				break;
			}
			this.#advanceDefiner(columns);
		}
		return cursorStep(value);
	}

	#advanceDefiner(columns: CoreValueCursorColumns): void {
		const live = this.#inResults ? columns.instructionLive : columns.blockLive;
		let definer = this.#definer + 1;
		while (definer < live.length) {
			this.#owner.assertCurrentGeneration();
			if (live[definer] === 1) break;
			definer++;
		}
		this.#index = 0;
		if (definer < live.length) {
			this.#definer = definer;
			this.#start = this.#inResults
				? columns.instructionResultStart[definer]!
				: columns.blockParameterStart[definer]!;
			this.#count = this.#inResults
				? columns.instructionResultCount[definer]!
				: columns.blockParameterCount[definer]!;
		} else if (this.#inResults) {
			this.#done = true;
			this.#count = 0;
		} else {
			this.#inResults = true;
			this.#definer = -1;
			this.#count = 0;
		}
	}
}
