import { unconfinedDynamicCode } from "../shared/compiler-facts.ts";
import type {
	CoreCompilationContext,
	ConstructedCoreCompilation,
} from "./core-compilation.ts";
import { CoreEditor } from "./core-editor.ts";
import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import { coreFunctionId, coreInstructionId } from "./core-ir.ts";
import type { CoreFunctionId, CoreInstructionId, CoreValueId } from "./core-ir.ts";
import { CORE_PROGRAM_FLOW_BODY } from "./core-store.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

interface GlobalWrite {
	readonly slot: number;
	readonly instruction: CoreInstructionId;
	readonly value: CoreValueId;
	readonly empty: boolean;
}

interface GlobalWriteScan {
	readonly bodyVersion: number;
	readonly writes: ReadonlyArray<GlobalWrite>;
}

const scans = new WeakMap<CoreFunctionStore, GlobalWriteScan>();

function globalWrites(fn: CoreFunctionStore): ReadonlyArray<GlobalWrite> {
	const bodyVersion = fn.hasActiveEditor ? undefined : fn.version("body");
	const cached = scans.get(fn);
	if (bodyVersion !== undefined && cached?.bodyVersion === bodyVersion)
		return cached.writes;
	const empty = (value: CoreValueId): boolean => {
		if (fn.kernel.valueDefinitionKind(value) !== 1) return false;
		const definition = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
		const opcode = fn.instructionOpcodeName(definition);
		return (
			opcode === "createEmpty" ||
			(opcode === "move" &&
				fn.kernel.instructionOperandCount(definition) === 1 &&
				empty(fn.kernel.operandAt(fn.kernel.instructionOperandStart(definition))))
		);
	};
	const writes: Array<GlobalWrite> = [];
	for (const instruction of fn.instructionIds()) {
		if (
			fn.instructionKind(instruction) !== "operation" ||
			fn.instructionOpcodeName(instruction) !== "storeGlobal" ||
			fn.kernel.instructionOperandCount(instruction) !== 1
		)
			continue;
		const slot = fn.instructionAttributes(instruction).index;
		if (typeof slot !== "number") continue;
		const value = fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction));
		writes.push({ slot, instruction, value, empty: empty(value) });
	}
	if (bodyVersion !== undefined) scans.set(fn, { bodyVersion, writes });
	return writes;
}

export interface CoreModuleGlobalWrites {
	readonly stores: ReadonlyArray<{
		readonly instruction: CoreInstructionId;
		readonly value: CoreValueId;
	}>;
	readonly resets: ReadonlyArray<CoreInstructionId>;
}

const lexicalSlotsByEvaluator = new WeakMap<
	NonNullable<CoreCompilationContext["data"]["moduleLexicalSlots"]>,
	ReadonlyMap<number, ReadonlyArray<number>>
>();

// Every function's value kinds ask for its cells, and only module evaluators own any.
function evaluatorLexicalSlots(
	context: CoreCompilationContext,
): ReadonlyMap<number, ReadonlyArray<number>> {
	const entries = context.data.moduleLexicalSlots;
	if (entries === undefined) return new Map();
	let byEvaluator = lexicalSlotsByEvaluator.get(entries);
	if (byEvaluator === undefined) {
		const map = new Map<number, Array<number>>();
		for (const { slot, evaluator } of entries) {
			const slots = map.get(evaluator) ?? [];
			slots.push(slot);
			map.set(evaluator, slots);
		}
		byEvaluator = map;
		lexicalSlotsByEvaluator.set(entries, byEvaluator);
	}
	return byEvaluator;
}

/**
 * The functions whose committed bodies assign each module lexical slot a value. The
 * program-flow log names every function an editor changed since the last refresh, and
 * functions still under an editor are scanned when asked about.
 */
class CoreLexicalWriterIndex {
	readonly #program: CoreProgram;
	readonly #slots: ReadonlySet<number>;
	readonly #writers = new Map<number, Set<CoreFunctionId>>();
	readonly #assigned = new Map<CoreFunctionId, ReadonlyArray<number>>();
	#generation = -1;
	#revision = 0;
	#capacity = 0;

	constructor(program: CoreProgram, slots: ReadonlySet<number>) {
		this.#program = program;
		this.#slots = slots;
	}

	/** Whether a function other than `owner` assigns `slot` a value. */
	assignedElsewhere(slot: number, owner: CoreFunctionId): boolean {
		this.#refresh();
		for (const writer of this.#writers.get(slot) ?? []) if (writer !== owner) return true;
		for (const id of this.#program.editingFunctions)
			if (id !== owner && this.#assignedSlots(this.#program.function(id)).includes(slot))
				return true;
		return false;
	}

	#assignedSlots(fn: CoreFunctionStore): ReadonlyArray<number> {
		return globalWrites(fn).flatMap((write) =>
			!write.empty && this.#slots.has(write.slot) ? [write.slot] : [],
		);
	}

	#scan(id: CoreFunctionId): void {
		for (const slot of this.#assigned.get(id) ?? []) this.#writers.get(slot)?.delete(id);
		this.#assigned.delete(id);
		if (!this.#program.hasFunction(id)) return;
		const slots = this.#assignedSlots(this.#program.function(id));
		if (slots.length === 0) return;
		this.#assigned.set(id, slots);
		for (const slot of slots) {
			const writers = this.#writers.get(slot) ?? new Set<CoreFunctionId>();
			writers.add(id);
			this.#writers.set(slot, writers);
		}
	}

	#refresh(): void {
		const program = this.#program;
		if (this.#generation !== program.generation) {
			// Finalizing the construction generation replaces every function and the log.
			this.#writers.clear();
			this.#assigned.clear();
			for (const id of program.functionIds()) this.#scan(id);
			this.#generation = program.generation;
		} else {
			for (
				let revision = this.#revision;
				revision < program.programFlowRevision;
				revision++
			)
				if ((program.programFlowDomainMaskAt(revision) & CORE_PROGRAM_FLOW_BODY) !== 0)
					this.#scan(program.programFlowFunctionAt(revision));
			for (let index = this.#capacity; index < program.functionCapacity; index++)
				this.#scan(coreFunctionId(index));
		}
		this.#revision = program.programFlowRevision;
		this.#capacity = program.functionCapacity;
	}
}

const lexicalWriterIndexes = new WeakMap<
	CoreProgram,
	{
		readonly entries: NonNullable<CoreCompilationContext["data"]["moduleLexicalSlots"]>;
		readonly index: CoreLexicalWriterIndex;
	}
>();

function lexicalWriterIndex(
	program: CoreProgram,
	entries: NonNullable<CoreCompilationContext["data"]["moduleLexicalSlots"]>,
): CoreLexicalWriterIndex {
	const cached = lexicalWriterIndexes.get(program);
	if (cached?.entries === entries) return cached.index;
	const index = new CoreLexicalWriterIndex(
		program,
		new Set(entries.map(({ slot }) => slot)),
	);
	lexicalWriterIndexes.set(program, { entries, index });
	return index;
}

/** The lexical slots of evaluator `id` that no other function assigns a value. */
function coreEvaluatorPrivateSlots(
	program: CoreProgram,
	context: CoreCompilationContext,
	id: CoreFunctionId,
): ReadonlyArray<number> {
	const entries = context.data.moduleLexicalSlots;
	if (
		unconfinedDynamicCode(context.facts) ||
		context.facts.closure.sourceClosure.kind !== "known" ||
		context.data.moduleLinks !== undefined ||
		entries === undefined
	)
		return [];
	const owned = evaluatorLexicalSlots(context).get(id);
	if (owned === undefined) return [];
	// Other functions may instantiate the TDZ, but cannot assign the binding.
	const writers = lexicalWriterIndex(program, entries);
	return owned.filter((slot) => !writers.assignedElsewhere(slot, id));
}

/**
 * Every evaluator's private lexical slots, decided once before a batch opens editors.
 * A batch that only forwards loads and drops stores can keep using them: its edits
 * add no writer, so a slot private before stays private.
 */
export function coreEvaluatorPrivateSlotMap(
	program: CoreProgram,
	context: CoreCompilationContext,
): ReadonlyMap<CoreFunctionId, ReadonlySet<number>> {
	const slots = new Map<CoreFunctionId, ReadonlySet<number>>();
	for (const evaluator of evaluatorLexicalSlots(context).keys()) {
		const id = coreFunctionId(evaluator);
		if (!program.hasFunction(id)) continue;
		const own = coreEvaluatorPrivateSlots(program, context, id);
		if (own.length > 0) slots.set(id, new Set(own));
	}
	return slots;
}

/** Private lexical cells whose non-empty writers all belong to this evaluator. */
export function coreEvaluatorGlobalWrites(
	program: CoreProgram,
	context: CoreCompilationContext,
	fn: CoreFunctionStore,
	// Private slots decided before a batch of editors opened, whose edits add no stores.
	privateSlots?: ReadonlyMap<CoreFunctionId, ReadonlySet<number>>,
): ReadonlyMap<number, CoreModuleGlobalWrites> {
	const cells = new Map<
		number,
		{ stores: Array<GlobalWrite>; resets: Array<CoreInstructionId> }
	>();
	for (const slot of privateSlots?.get(fn.id) ??
		(privateSlots === undefined
			? coreEvaluatorPrivateSlots(program, context, fn.id)
			: []))
		cells.set(slot, { stores: [], resets: [] });
	if (cells.size === 0) return cells;
	for (const write of globalWrites(fn)) {
		const cell = cells.get(write.slot);
		if (cell === undefined) continue;
		if (write.empty) cell.resets.push(write.instruction);
		else cell.stores.push(write);
	}
	return cells;
}

/** A dominating value store must follow every explicit reset in the evaluator. */
export function coreModuleGlobalLoadInitialized(
	fn: CoreFunctionStore,
	control: CoreControlFlow,
	cell: CoreModuleGlobalWrites,
	load: CoreInstructionId,
): boolean {
	const precedes = (first: CoreInstructionId, second: CoreInstructionId): boolean => {
		const firstBlock = fn.instructionBlock(first);
		const secondBlock = fn.instructionBlock(second);
		if (firstBlock !== secondBlock)
			return control.instructionDominatesBlock(firstBlock, secondBlock);
		for (const instruction of fn.instructionIds(firstBlock)) {
			if (instruction === second) return false;
			if (instruction === first) return true;
		}
		return false;
	};
	return cell.stores.some(
		(store) =>
			precedes(store.instruction, load) &&
			cell.resets.every((reset) => precedes(reset, store.instruction)),
	);
}

/** Global slots an instruction other than a binding store reads or hands to the runtime. */
function referencedGlobalSlots(
	opcode: string,
	attributes: Readonly<Record<string, unknown>>,
): ReadonlyArray<number> {
	const slots: Array<number> = [];
	for (const key of ["index", "cacheSlot", "foreignSlot"])
		if (
			typeof attributes[key] === "number" &&
			(key !== "index" || opcode === "loadGlobal" || opcode === "loadGlobalIndex")
		)
			slots.push(attributes[key]);
	if (opcode === "createModuleNamespace" && Array.isArray(attributes.exports))
		for (const entry of attributes.exports as ReadonlyArray<unknown>)
			if (
				entry !== null &&
				typeof entry === "object" &&
				"slot" in entry &&
				typeof entry.slot === "number"
			)
				slots.push(entry.slot);
	return slots;
}

const readScans = new WeakMap<
	CoreFunctionStore,
	{ readonly bodyVersion: number; readonly slots: ReadonlyArray<number> }
>();

function globalSlotReads(fn: CoreFunctionStore): ReadonlyArray<number> {
	const bodyVersion = fn.hasActiveEditor ? undefined : fn.version("body");
	const cached = readScans.get(fn);
	if (bodyVersion !== undefined && cached?.bodyVersion === bodyVersion)
		return cached.slots;
	const slots: Array<number> = [];
	for (const instruction of fn.instructionIds()) {
		if (fn.instructionKind(instruction) !== "operation") continue;
		const opcode = fn.instructionOpcodeName(instruction);
		if (opcode !== "storeGlobal")
			slots.push(...referencedGlobalSlots(opcode, fn.instructionAttributes(instruction)));
	}
	if (bodyVersion !== undefined) readScans.set(fn, { bodyVersion, slots });
	return slots;
}

/**
 * Module binding slots that no instruction of `functions` reads. In a closed program
 * only Core instructions and host installers reach a module binding, so stores to one
 * of these write values no code can observe.
 */
export function coreUnreadModuleBindingSlots(
	program: CoreProgram,
	context: CoreCompilationContext,
	functions: Iterable<CoreFunctionId>,
): Set<number> {
	const unread = new Set(context.data.moduleBindingSlots ?? []);
	for (const { exports } of context.data.hostInstallCandidates)
		for (const { slot } of exports) unread.delete(slot);
	if (unread.size === 0) return unread;
	for (const id of functions)
		for (const slot of globalSlotReads(program.function(id))) unread.delete(slot);
	return unread;
}

/** The stores of `fn` to slots in `unread`. */
export function coreUnreadModuleBindingStores(
	fn: CoreFunctionStore,
	unread: ReadonlySet<number>,
): Array<CoreInstructionId> {
	const stores: Array<CoreInstructionId> = [];
	if (unread.size === 0) return stores;
	for (const instruction of fn.instructionIds()) {
		if (
			fn.instructionKind(instruction) !== "operation" ||
			fn.instructionOpcodeName(instruction) !== "storeGlobal"
		)
			continue;
		const slot = fn.instructionAttributes(instruction).index;
		if (typeof slot === "number" && unread.has(slot)) stores.push(instruction);
	}
	return stores;
}

/**
 * Drops the stores to module bindings nothing reads, so dead-code elimination can
 * remove the initializers that only fed them.
 */
export function pruneUnreadModuleBindings(compilation: ConstructedCoreCompilation): void {
	const { program, context } = compilation;
	const unread = coreUnreadModuleBindingSlots(program, context, program.functionIds());
	if (unread.size === 0) return;
	for (const id of program.functionIds()) {
		const stores = coreUnreadModuleBindingStores(program.function(id), unread);
		if (stores.length === 0) continue;
		const editor = CoreEditor.open(program, id);
		for (const store of stores) editor.removeInstruction(store);
		editor.commit();
	}
}

/** How a program reads and assigns its global slots, from each function's cached scans. */
export interface CoreGlobalSlotUses {
	/** Instructions that read each slot or hand it to the runtime. */
	readonly reads: ReadonlyMap<number, number>;
	/** The values each slot is assigned, besides its dead-zone marker. */
	readonly writes: ReadonlyMap<
		number,
		ReadonlyArray<{ readonly function: CoreFunctionId; readonly value: CoreValueId }>
	>;
}

export function coreGlobalSlotUses(program: CoreProgram): CoreGlobalSlotUses {
	const reads = new Map<number, number>();
	const writes = new Map<
		number,
		Array<{ function: CoreFunctionId; value: CoreValueId }>
	>();
	for (const id of program.functionIds()) {
		const fn = program.function(id);
		for (const slot of globalSlotReads(fn)) reads.set(slot, (reads.get(slot) ?? 0) + 1);
		for (const write of globalWrites(fn)) {
			if (write.empty) continue;
			const values = writes.get(write.slot) ?? [];
			values.push({ function: id, value: write.value });
			writes.set(write.slot, values);
		}
	}
	return { reads, writes };
}
