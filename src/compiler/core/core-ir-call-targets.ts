/**
 * Bounded callee-target analysis: which ordinary script functions an SSA value,
 * a compiler-owned global slot, or a captured closure slot can hold.
 *
 * The lattice is a product of a sorted finite script-function set and two
 * independent loss bits, so losing one kind of precision never discards the
 * other. `opaque` records "some callable this analysis cannot name" and
 * deliberately keeps the named candidates, because a singleton plus an open
 * possibility is exactly the shape a guarded specialization consumes. Only
 * finite overflow past `CORE_CALLEE_TARGET_CAP` widens, and it widens to
 * `anyScript` rather than to a wrong answer.
 *
 * The solver is one dependency graph plus a monotone worklist. Every transfer
 * function here is the join of the node's in-edges — `createFunction` seeds a
 * singleton, `move`, loads, stores, and block arguments are identities — so
 * pushing a raised value along out-edges is exact, and no CFG is ever rebuilt in
 * a whole-program round.
 *
 * Call results join the same graph through one cell per function holding
 * everything that function returns. A call site depends on its callee cell
 * reactively: each finite target the callee is proven to hold opens an edge from
 * that target's return cell to the call's result exactly once, and an open callee
 * raises the result's matching open component at most once. Because a cell's
 * finite set only grows and only up to the cap before it widens away, the
 * whole-program solve stays one worklist with no rescan of calls or functions.
 *
 * Soundness rests on the registry being the single declaration of which memory
 * an opcode names. Every write to `global-slot` or `captured-slot` either names
 * its cell and its stored value (`storeGlobal`, `storeCaptured`) or appears in
 * `SLOT_WRITERS_WITHOUT_NEW_CALLABLES` with the reason it cannot publish a
 * callable; anything else degrades its whole family. Host-installed slots are
 * opaque because the host, not this graph, writes them. Direct eval needs no
 * special case: the frontend marshals bindings into a scope object and writes
 * them back through ordinary stores, so an eval-mutated binding reaches its slot
 * as a store of an unresolvable value.
 */

import type { CoreCompilationContext } from "./core-compilation.ts";
import { corePredecessorEdges } from "./core-ir-control-flow.ts";
import { coreMemoryAccesses } from "./core-ir-memory.ts";
import { coreOpcodeRegistry } from "./core-ir-opcodes.ts";
import { coreOwnCellResolver, coreOwnCellsEqual } from "./core-ir-provenance.ts";
import type { CoreOwnCell } from "./core-ir-provenance.ts";
import { CORE_MEMORY_FAMILY_DOMAINS } from "./core-ir.ts";
import type {
	CoreAccessMode,
	CoreAttributeObject,
	CoreInstruction,
	CoreInstructionId,
	CoreOpcodeAccess,
	CoreOpcodeAllocation,
	CoreOpcodeRegistry,
	CoreProgram,
	CoreValueId,
} from "./core-ir.ts";

/**
 * Largest finite target set kept per cell. The bound is a cost decision, not an
 * analysis one: past four candidates no consumer — guard chain, dispatch table,
 * or joined summary — pays for itself, and the cap is what keeps the solver's
 * lattice height, and therefore its running time, linear in program size.
 */
export const CORE_CALLEE_TARGET_CAP = 4;

/**
 * What a cell can hold, as seen by callee resolution.
 *
 * `functions` is sorted, deduplicated, and at most `CORE_CALLEE_TARGET_CAP`
 * long. `anyScript` means the finite set overflowed, so any script function may
 * flow here and `functions` is empty. `opaque` means a callable outside this
 * analysis's vocabulary — a builtin, a bound or native function, a Proxy, or an
 * unresolved producer — may also flow here, and it never erases `functions`.
 * Bottom (all empty and false) means no callable has been observed at all.
 */
export interface CoreCalleeTargets {
	readonly functions: ReadonlyArray<number>;
	readonly anyScript: boolean;
	readonly opaque: boolean;
}

const NO_FUNCTIONS: ReadonlyArray<number> = Object.freeze([]);

export const CORE_CALLEE_TARGETS_BOTTOM: CoreCalleeTargets = Object.freeze({
	functions: NO_FUNCTIONS,
	anyScript: false,
	opaque: false,
});

/** A callable this analysis cannot name, with no script candidate. */
export const CORE_CALLEE_TARGETS_OPAQUE: CoreCalleeTargets = Object.freeze({
	functions: NO_FUNCTIONS,
	anyScript: false,
	opaque: true,
});

/** More script functions than the cap; every named candidate is widened away. */
export const CORE_CALLEE_TARGETS_ANY_SCRIPT: CoreCalleeTargets = Object.freeze({
	functions: NO_FUNCTIONS,
	anyScript: true,
	opaque: false,
});

export function coreCalleeTargetsFunction(functionIndex: number): CoreCalleeTargets {
	return Object.freeze({
		functions: Object.freeze([functionIndex]),
		anyScript: false,
		opaque: false,
	});
}

export function coreCalleeTargetsEqual(
	left: CoreCalleeTargets,
	right: CoreCalleeTargets,
): boolean {
	return (
		left.anyScript === right.anyScript &&
		left.opaque === right.opaque &&
		left.functions.length === right.functions.length &&
		left.functions.every((entry, index) => entry === right.functions[index])
	);
}

function sortedFunctionTargetsContain(
	superset: ReadonlyArray<number>,
	subset: ReadonlyArray<number>,
): boolean {
	let supersetIndex = 0;
	for (const candidate of subset) {
		while (supersetIndex < superset.length && superset[supersetIndex]! < candidate) {
			supersetIndex++;
		}
		if (superset[supersetIndex] !== candidate) return false;
		supersetIndex++;
	}
	return true;
}

/**
 * Component-wise join. Overflow past the cap widens the script component to
 * `anyScript`; the opacity bit is an independent logical or, so joining an
 * unresolvable source keeps every candidate already proven to reach the cell.
 */
export function joinCoreCalleeTargets(
	left: CoreCalleeTargets,
	right: CoreCalleeTargets,
): CoreCalleeTargets {
	if (left === right) return left;
	const opaque = left.opaque || right.opaque;
	if (left.anyScript || right.anyScript) {
		return opaque ? CORE_CALLEE_TARGETS_TOP : CORE_CALLEE_TARGETS_ANY_SCRIPT;
	}
	if (left.functions.length === 0 && right.functions.length === 0) {
		return opaque ? CORE_CALLEE_TARGETS_OPAQUE : CORE_CALLEE_TARGETS_BOTTOM;
	}
	if (left.functions.length === 0) {
		if (!left.opaque || right.opaque) return right;
		return Object.freeze({
			functions: right.functions,
			anyScript: false,
			opaque: true,
		});
	}
	if (right.functions.length === 0) {
		if (!right.opaque || left.opaque) return left;
		return Object.freeze({
			functions: left.functions,
			anyScript: false,
			opaque: true,
		});
	}
	if (
		left.opaque === opaque &&
		sortedFunctionTargetsContain(left.functions, right.functions)
	) {
		return left;
	}
	if (
		right.opaque === opaque &&
		sortedFunctionTargetsContain(right.functions, left.functions)
	) {
		return right;
	}

	const merged: Array<number> = [];
	let leftIndex = 0;
	let rightIndex = 0;
	while (leftIndex < left.functions.length || rightIndex < right.functions.length) {
		const leftTarget = left.functions[leftIndex];
		const rightTarget = right.functions[rightIndex];
		let target: number;
		if (
			rightTarget === undefined ||
			(leftTarget !== undefined && leftTarget < rightTarget)
		) {
			target = leftTarget!;
			leftIndex++;
		} else if (leftTarget === undefined || rightTarget < leftTarget) {
			target = rightTarget;
			rightIndex++;
		} else {
			target = leftTarget;
			leftIndex++;
			rightIndex++;
		}
		merged.push(target);
		if (merged.length > CORE_CALLEE_TARGET_CAP) {
			return opaque ? CORE_CALLEE_TARGETS_TOP : CORE_CALLEE_TARGETS_ANY_SCRIPT;
		}
	}
	return Object.freeze({
		functions: Object.freeze(merged),
		anyScript: false,
		opaque,
	});
}

/**
 * Every callable at once: any script function and any callable this analysis
 * cannot name. This is the lattice top.
 */
export const CORE_CALLEE_TARGETS_TOP: CoreCalleeTargets = Object.freeze({
	functions: NO_FUNCTIONS,
	anyScript: true,
	opaque: true,
});

/** No callable has been observed: the cell is unreachable or uninitialized. */
export function coreCalleeTargetsIsBottom(targets: CoreCalleeTargets): boolean {
	return !targets.anyScript && !targets.opaque && targets.functions.length === 0;
}

/** A possibility this analysis could not name remains. */
export function coreCalleeTargetsAreOpen(targets: CoreCalleeTargets): boolean {
	return targets.anyScript || targets.opaque;
}

/**
 * The single script function this cell can hold, whether or not an open
 * possibility remains. A consumer that reads this must tolerate a live callee
 * that is not the named target.
 */
export function coreCalleeTargetsSingleFunction(
	targets: CoreCalleeTargets,
): number | undefined {
	return !targets.anyScript && targets.functions.length === 1
		? targets.functions[0]
		: undefined;
}

/**
 * The single script function this cell can hold, with every other possibility
 * ruled out. This is the only form a consumer may treat as an unguarded fact.
 */
export function coreCalleeTargetsClosedFunction(
	targets: CoreCalleeTargets,
): number | undefined {
	return coreCalleeTargetsAreOpen(targets)
		? undefined
		: coreCalleeTargetsSingleFunction(targets);
}

export interface CoreCalleeTargetStatistics {
	readonly nodes: number;
	readonly edges: number;
	/** Times a node's state strictly rose; bounded by nodes times the height. */
	readonly propagations: number;
	/**
	 * Return-cell edges and open-component raises a call site activated. Bounded by
	 * `CORE_CALLEE_TARGET_CAP + 2` per site, which is what keeps a resolvable call
	 * from turning the solve into a whole-program round.
	 */
	readonly callActivations: number;
	/** Declared aggregate layouts this analysis modelled, bounded by the cap. */
	readonly trackedAllocations: number;
	/** Those whose whole operation set this graph contains, so their cells joined it. */
	readonly containedAllocations: number;
	readonly ownCellNodes: number;
	/** Compiler-owned cells whose whole read and write traffic this graph contains. */
	readonly singleAssignmentCells: number;
}

export interface CoreCalleeTargetAnalysis {
	/** Targets of an SSA value; unknown values answer bottom. */
	targets(functionIndex: number, value: CoreValueId): CoreCalleeTargets;
	globalSlot(slot: number): CoreCalleeTargets;
	capturedSlot(owner: number, index: number): CoreCalleeTargets;
	/** Everything this function's ordinary returns can hand back to a caller. */
	returnTargets(functionIndex: number): CoreCalleeTargets;
	readonly statistics: CoreCalleeTargetStatistics;
}

/**
 * Writers that name a slot family without naming a cell, and the reason each one
 * cannot publish a callable into a cell this analysis names. Anything else that
 * writes `global-slot` or `captured-slot` without naming its cell degrades that
 * whole family, so a newly added opcode is conservative by default.
 */
const SLOT_WRITERS_WITHOUT_NEW_CALLABLES: ReadonlySet<string> = new Set([
	// Declaration-initializes global var properties to undefined.
	"initGlobalVars",
	// Mints fresh hidden symbols, never a function object.
	"createPrivateNames",
	// A per-iteration environment is a sibling holding the same synthetic scope id
	// and slot indices, so a copied cell keeps the key whose join already covers
	// every value stored to it.
	"envPush",
	"envCopy",
	"envPop",
]);

/**
 * Largest number of fresh aggregates whose own cells this analysis models. Past
 * the cap an allocation is untracked, which costs precision only: its cells stay
 * opaque like any property this analysis cannot name.
 */
export const CORE_TRACKED_ALLOCATION_CAP = 1024;

/**
 * Largest declared own-slot count of a tracked aggregate. A wider literal is not
 * modelled at all rather than modelled partially, because a partial cell map
 * cannot tell "no writer stored here" from "a writer we chose not to keep".
 */
export const CORE_OWN_CELL_KEY_CAP = 16;

/**
 * Family-level slot writers that provably leave every cell holding a value some
 * cell-naming store already wrote, with the reason each one does.
 *
 * This is strictly stronger than `SLOT_WRITERS_WITHOUT_NEW_CALLABLES`, which only
 * promises not to introduce a *callable*. Carrying an allocation identity through
 * a cell needs the full value contract, so `createPrivateNames` and
 * `initGlobalVars` — both of which write cells they do not name — are deliberately
 * absent, and a newly added family writer is excluded by default.
 */
const SLOT_FAMILY_WRITERS_PRESERVING_CELL_VALUES: ReadonlySet<string> = new Set([
	// A per-iteration environment is a sibling holding the same synthetic scope id
	// and slot indices, so every cell of the copy holds a value stored through the
	// same key as the cell it was copied from.
	"envPush",
	"envCopy",
	"envPop",
]);

function attributeNumber(instruction: CoreInstruction, key: string): number | undefined {
	const value = instruction.attributes[key];
	return typeof value === "number" ? value : undefined;
}

function capturedSlotKey(owner: number, index: number): string {
	return `${owner}:${index}`;
}

/** A compiler-owned cell a declared access names exactly. */
type SlotCell =
	| { readonly kind: "global"; readonly slot: number }
	| {
			readonly kind: "captured";
			readonly owner: number;
			readonly index: number;
	  };

/**
 * The cell a declared slot access names, or undefined when the instruction does
 * not carry the attributes the descriptor promised. Decoding from the descriptor
 * rather than from an opcode name is what keeps this from drifting away from the
 * memory model's own answer.
 */
function declaredSlotCell(
	instruction: CoreInstruction,
	access: CoreOpcodeAccess,
): SlotCell | undefined {
	const attributes = access.attributes ?? [];
	if (access.family === "global-slot") {
		if (attributes.length !== 1) return undefined;
		const slot = attributeNumber(instruction, attributes[0]!);
		return slot === undefined ? undefined : { kind: "global", slot };
	}
	if (access.family !== "captured-slot" || attributes.length !== 2) return undefined;
	const owner = attributeNumber(instruction, attributes[0]!);
	const index = attributeNumber(instruction, attributes[1]!);
	return owner === undefined || index === undefined
		? undefined
		: { kind: "captured", owner, index };
}

/** Key spelling a declared access carries, before own-cell normalization. */
function declaredAccessKeyCell(
	instruction: CoreInstruction,
	access: CoreOpcodeAccess,
	cellForString: (index: number) => CoreOwnCell | undefined,
	cellForOperand: (value: CoreValueId) => CoreOwnCell | undefined,
): CoreOwnCell | undefined {
	if (access.keyAttribute !== undefined) {
		const index = attributeNumber(instruction, access.keyAttribute);
		return index === undefined ? undefined : cellForString(index);
	}
	if (access.keyOperand === undefined) return undefined;
	const value = instruction.inputs[access.keyOperand];
	return value === undefined ? undefined : cellForOperand(value);
}

interface SlotCensus {
	/** A family write that may publish a callable into a cell it does not name. */
	global: boolean;
	captured: boolean;
	/** A family write that may replace a cell's value with something unnamed. */
	globalOverwrite: boolean;
	capturedOverwrite: boolean;
	/** A family read, so cells in it are served to code outside this graph. */
	globalPublished: boolean;
	capturedPublished: boolean;
	/** Named global cells whose writer does not name the value it stores. */
	readonly opaqueGlobalSlots: Set<number>;
	readonly opaqueCapturedSlots: Map<string, readonly [number, number]>;
	/** Cell-naming writes per cell, counted so single assignment is checkable. */
	readonly globalWriters: Map<number, number>;
	readonly capturedWriters: Map<string, number>;
}

/**
 * Census every declared slot access in the program.
 *
 * Naming the cell and naming the stored value are independent obligations, so
 * they degrade independently:
 *
 * - A writer that cannot name its cell degrades its whole family, because any
 *   cell in it may now hold anything.
 * - A writer that names its cell but stores something other than an operand —
 *   `createTemplateObject` caches its own result in a private per-site slot —
 *   makes exactly that cell opaque.
 *
 * Cells come from the shared memory-access query rather than a second attribute
 * decoder here, so the answer cannot drift from the opcode's declared memory and
 * a verified effect refinement that removed the write removes it here too.
 */
function censusSlotAccesses(
	program: CoreProgram,
	registry: CoreOpcodeRegistry,
): SlotCensus {
	const census: SlotCensus = {
		global: false,
		captured: false,
		globalOverwrite: false,
		capturedOverwrite: false,
		globalPublished: false,
		capturedPublished: false,
		opaqueGlobalSlots: new Set(),
		opaqueCapturedSlots: new Map(),
		globalWriters: new Map(),
		capturedWriters: new Map(),
	};
	for (const fn of program.functions) {
		const producers = new Array<CoreInstruction | undefined>(
			(fn.values.at(-1)?.id ?? -1) + 1,
		).fill(undefined);
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				for (const output of instruction.outputs) producers[output] = instruction;
			}
		}
		/**
		 * A store of the uninitialized sentinel is the frontend's TDZ setup, not an
		 * assignment: a read that observes it throws before it can observe anything,
		 * so it cannot be the value a later read sees and it does not make a
		 * single-assignment binding multiply assigned.
		 */
		const storesSentinel = (value: CoreValueId): boolean => {
			let current = value;
			for (;;) {
				const producer = producers[current];
				if (producer === undefined) return false;
				if (producer.opcode === "createEmpty") return true;
				if (producer.opcode !== "move" || producer.inputs.length !== 1) return false;
				// A move's input dominates its output definition in verified SSA, so this
				// producer walk is acyclic without a per-query visited set.
				current = producer.inputs[0]!;
			}
		};
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				const introducesCallable = !SLOT_WRITERS_WITHOUT_NEW_CALLABLES.has(
					instruction.opcode,
				);
				const preservesValues = SLOT_FAMILY_WRITERS_PRESERVING_CELL_VALUES.has(
					instruction.opcode,
				);
				for (const access of coreMemoryAccesses(instruction, undefined, registry)) {
					const location = access.location;
					if (location.kind === "family") {
						const global = location.family === "global-slot";
						if (!global && location.family !== "captured-slot") continue;
						if (access.mode === "read") {
							if (global) census.globalPublished = true;
							else census.capturedPublished = true;
							continue;
						}
						if (global) {
							if (introducesCallable) census.global = true;
							if (!preservesValues) census.globalOverwrite = true;
						} else {
							if (introducesCallable) census.captured = true;
							if (!preservesValues) census.capturedOverwrite = true;
						}
						continue;
					}
					if (access.mode !== "write") continue;
					const assigns = access.value === undefined || !storesSentinel(access.value);
					if (location.kind === "global-slot") {
						if (assigns) {
							census.globalWriters.set(
								location.slot,
								(census.globalWriters.get(location.slot) ?? 0) + 1,
							);
						}
						if (access.value === undefined) census.opaqueGlobalSlots.add(location.slot);
					} else if (location.kind === "captured-slot") {
						const key = capturedSlotKey(location.owner, location.index);
						if (assigns) {
							census.capturedWriters.set(key, (census.capturedWriters.get(key) ?? 0) + 1);
						}
						if (access.value === undefined) {
							census.opaqueCapturedSlots.set(key, [location.owner, location.index]);
						}
					}
				}
			}
		}
	}
	return census;
}

/**
 * Compiler-owned cells whose whole read and write traffic this graph contains.
 *
 * The contract a member cell satisfies is: every read of it anywhere in the
 * program is one of the reads in this graph, and every such read observes either
 * the uninitialized sentinel or a value written by the one store the frontend
 * emitted for its binding. That is what lets an allocation identity survive a
 * trip through a cell instead of being lost at the function boundary.
 *
 * Four independent obligations, none of which a declaration alone discharges:
 *
 * 1. The frontend declares the binding single-assignment. Only `const` and a
 *    named function expression's own name are; a `var` or `let` cell is not, and
 *    an import contributes its exporter's cell because the linker aliases the two
 *    onto one cell rather than copying a value out of it.
 * 2. Exactly one instruction in the program writes the cell by name, and it names
 *    the value it stores.
 * 3. No family-level writer could replace the cell's value with something this
 *    graph does not name.
 * 4. Nothing serves the cell to code outside this graph: no host installer owns
 *    it, and no family-level reader — a module namespace object resolves each
 *    export live from its slot on every get — republishes it.
 *
 * Obligation 1 alone would be an inference from a declaration; obligations 2 to 4
 * are what make it a fact about this program's graph.
 */
export interface CoreSingleAssignmentCells {
	globalSlot(slot: number): boolean;
	capturedSlot(owner: number, index: number): boolean;
	readonly count: number;
}

function singleAssignmentCellsFromCensus(
	program: CoreProgram,
	census: SlotCensus,
	context: CoreCompilationContext | undefined,
): CoreSingleAssignmentCells {
	const hostSlots = new Set<number>();
	for (const candidate of context?.data.hostInstallCandidates ?? []) {
		for (const { slot } of candidate.exports) hostSlots.add(slot);
	}
	const globals = new Set<number>();
	if (!census.globalOverwrite && !census.globalPublished) {
		for (const slot of context?.data.singleAssignmentGlobalSlots ?? []) {
			if (hostSlots.has(slot)) continue;
			if (census.opaqueGlobalSlots.has(slot)) continue;
			if (census.globalWriters.get(slot) !== 1) continue;
			globals.add(slot);
		}
	}
	const captured = new Set<string>();
	if (!census.capturedOverwrite && !census.capturedPublished) {
		for (const { owner, index } of context?.data.singleAssignmentCapturedSlots ?? []) {
			const key = capturedSlotKey(owner, index);
			if (census.opaqueCapturedSlots.has(key)) continue;
			if (census.capturedWriters.get(key) !== 1) continue;
			captured.add(key);
		}
	}
	return {
		globalSlot: (slot) => globals.has(slot),
		capturedSlot: (owner, index) => captured.has(capturedSlotKey(owner, index)),
		count: globals.size + captured.size,
	};
}

/** Re-derive a program's single-assignment cells from its graph alone. */
export function coreSingleAssignmentCells(
	program: CoreProgram,
	registry: CoreOpcodeRegistry = coreOpcodeRegistry,
	context?: CoreCompilationContext,
): CoreSingleAssignmentCells {
	return singleAssignmentCellsFromCensus(
		program,
		censusSlotAccesses(program, registry),
		context,
	);
}

/**
 * A fresh aggregate whose own data slots the registry declares, identified
 * program-wide rather than per function: an allocation reached through a
 * compiler-owned cell is named from every function that reads that cell.
 */
interface TrackedAllocation {
	readonly functionIndex: number;
	readonly instruction: CoreInstructionId;
	/** Module namespace exotic objects cannot be mutated through an escaped alias. */
	readonly immutable: boolean;
	/** Canonical own-slot keys in declaration order. */
	readonly keys: ReadonlyArray<number>;
	/** Node holding each key's initial value, in the same order. */
	readonly initialValues: ReadonlyArray<number>;
	readonly owned: ReadonlySet<number>;
}

/**
 * Layout of a declared named-slot allocation, or undefined when it is not one
 * this analysis models exactly.
 *
 * Indexed allocations are deliberately excluded: an element no dominating define
 * filled is a hole, and a hole read continues to the prototype chain, where a
 * value this graph never saw could answer. Every declared key of a named-slot
 * literal is an own writable data property from the moment the object exists, so
 * no read or write of a declared key can leave the object.
 */
function namedSlotLayout(
	instruction: CoreInstruction,
	allocation: CoreOpcodeAllocation,
	cellForString: (index: number) => CoreOwnCell | undefined,
):
	| {
			readonly keys: ReadonlyArray<number>;
			readonly values: ReadonlyArray<CoreValueId>;
	  }
	| undefined {
	if (allocation.kind !== "named-slots") return undefined;
	const declared = instruction.attributes[allocation.keysAttribute];
	if (
		!Array.isArray(declared) ||
		!declared.every((entry) => typeof entry === "number" && Number.isSafeInteger(entry))
	) {
		return undefined;
	}
	if (declared.length > CORE_OWN_CELL_KEY_CAP) return undefined;
	const values = instruction.inputs.slice(allocation.firstValueOperand);
	if (values.length !== declared.length) return undefined;
	const keys: Array<number> = [];
	for (const entry of declared as ReadonlyArray<number>) {
		const cell = cellForString(entry);
		// An index-shaped spelling names an element rather than a named slot, and a
		// repeated canonical key would make two cells indistinguishable.
		if (cell?.kind !== "object-slot" || keys.includes(cell.key)) return undefined;
		keys.push(cell.key);
	}
	return { keys, values };
}

/** How an operand uses whatever allocation it holds. */
type OperandRole =
	| { readonly kind: "observed" }
	| {
			readonly kind: "own-slot";
			readonly key: number;
			readonly mode: CoreAccessMode;
			readonly valueOperand: number | undefined;
	  }
	| { readonly kind: "cell-store"; readonly cell: SlotCell }
	| { readonly kind: "escape" };

const OPERAND_OBSERVED: OperandRole = Object.freeze({ kind: "observed" });
const OPERAND_ESCAPE: OperandRole = Object.freeze({ kind: "escape" });

/**
 * The one place where an operand's role depends on an attribute rather than on its
 * position: strict equality and `typeof` inspect a reference without handing it to
 * user code. Everything else comes from the registry's declarations.
 */
function operandsAreObservedOnly(
	instruction: CoreInstruction,
	registry: CoreOpcodeRegistry,
): boolean {
	if (registry.require(instruction.opcode).observesOperands === true) return true;
	const operator = instruction.attributes.operator;
	if (instruction.opcode === "binary") return operator === "===" || operator === "!==";
	if (instruction.opcode === "unary") return operator === "typeof";
	return false;
}

interface BaseAccessSummary {
	slots: number;
	shapes: number;
	prototypeReads: number;
	unclassified: number;
	slotKey: CoreOwnCell | undefined;
	slotMode: CoreAccessMode;
	slotValueOperand: number | undefined;
	shapeKey: CoreOwnCell | undefined;
	establishes: boolean;
}

/**
 * Role of every operand of one instruction, derived from its declared accesses.
 *
 * A base operand keeps its allocation only when the instruction reads or writes
 * exactly one named own data slot of it, or only reads its prototype. A shape
 * edit, an accessor definition, a delete, a prototype replacement, or an
 * unresolvable key is an escape: those are exactly the operations that could turn
 * a slot into an accessor, install a Proxy, or send a later lookup to the
 * prototype chain. A shape write is tolerated only beside the own-data define
 * that declared it, on the same key, so declaration order cannot decide safety.
 * Every operand the registry does not describe as addressing an object escapes,
 * which is what keeps a newly added opcode conservative.
 */
function operandRoles(
	instruction: CoreInstruction,
	registry: CoreOpcodeRegistry,
	keyCell: (access: CoreOpcodeAccess) => CoreOwnCell | undefined,
): ReadonlyMap<number, OperandRole> {
	const roles = new Map<number, OperandRole>();
	if (operandsAreObservedOnly(instruction, registry)) {
		for (const [operand] of instruction.inputs.entries()) {
			roles.set(operand, OPERAND_OBSERVED);
		}
		return roles;
	}
	const bases = new Map<number, BaseAccessSummary>();
	for (const access of registry.require(instruction.opcode).accesses ?? []) {
		if (
			access.valueOperand !== undefined &&
			access.mode === "write" &&
			(access.family === "global-slot" || access.family === "captured-slot")
		) {
			const cell = declaredSlotCell(instruction, access);
			roles.set(
				access.valueOperand,
				cell === undefined ? OPERAND_ESCAPE : { kind: "cell-store", cell },
			);
		}
		if (access.baseOperand === undefined) continue;
		if (!CORE_MEMORY_FAMILY_DOMAINS[access.family].includes("object-property")) continue;
		let summary = bases.get(access.baseOperand);
		if (summary === undefined) {
			summary = {
				slots: 0,
				shapes: 0,
				prototypeReads: 0,
				unclassified: 0,
				slotKey: undefined,
				slotMode: "read",
				slotValueOperand: undefined,
				shapeKey: undefined,
				establishes: false,
			};
			bases.set(access.baseOperand, summary);
		}
		if (access.family === "object-slot") {
			summary.slots += 1;
			summary.slotKey = keyCell(access);
			summary.slotMode = access.mode;
			summary.slotValueOperand = access.valueOperand;
			if (access.establishesOwnDataSlot === true) summary.establishes = true;
		} else if (access.family === "shape" && access.mode === "write") {
			summary.shapes += 1;
			summary.shapeKey = keyCell(access);
		} else if (access.family === "prototype" && access.mode === "read") {
			summary.prototypeReads += 1;
		} else {
			summary.unclassified += 1;
		}
	}
	for (const [operand, summary] of bases) {
		roles.set(operand, baseOperandRole(summary));
	}
	for (const [operand] of instruction.inputs.entries()) {
		if (!roles.has(operand)) roles.set(operand, OPERAND_ESCAPE);
	}
	return roles;
}

function baseOperandRole(summary: BaseAccessSummary): OperandRole {
	if (summary.unclassified > 0) return OPERAND_ESCAPE;
	if (summary.slots === 0 && summary.shapes === 0) {
		// [[GetPrototypeOf]] on an ordinary object runs no trap and retains nothing.
		return summary.prototypeReads > 0 ? OPERAND_OBSERVED : OPERAND_ESCAPE;
	}
	if (summary.slots !== 1 || summary.prototypeReads > 0) return OPERAND_ESCAPE;
	const slot = summary.slotKey;
	if (slot?.kind !== "object-slot") return OPERAND_ESCAPE;
	const role: OperandRole = {
		kind: "own-slot",
		key: slot.key,
		mode: summary.slotMode,
		valueOperand: summary.slotValueOperand,
	};
	if (summary.shapes === 0) return role;
	// A shape write stands only beside the own-data define that declared it, on the
	// same key, so declaration order cannot decide safety.
	return summary.shapes === 1 &&
		summary.establishes &&
		summary.shapeKey !== undefined &&
		coreOwnCellsEqual(summary.shapeKey, slot)
		? role
		: OPERAND_ESCAPE;
}

/**
 * One call site's reactive dependency on its callee cell.
 *
 * `activated` and `openRaised` make the dependency bounded: a callee cell's finite
 * set only grows and only to the cap before it widens away, so a site wires at
 * most `CORE_CALLEE_TARGET_CAP` return cells and raises each open component at
 * most once, however many times the callee cell rises.
 */
interface CallResultSite {
	readonly callee: number;
	readonly result: number;
	/** [[Construct]] rather than [[Call]], which changes what the result can be. */
	readonly construct: boolean;
	readonly activated: Set<number>;
	openRaised: "none" | "opaque" | "top";
}

/**
 * A static property read from the direct result of `new C(...)`.
 *
 * The result stays open: a live prototype mutation or a replacement/Proxy
 * constructor may replace what the load observes. The compiler-created
 * base-class prototype still contributes guarded method candidates, and every
 * consumer must retain its generic mismatch path.
 */
interface ConstructorMethodSite {
	readonly callee: number;
	readonly result: number;
	readonly key: number;
	readonly activated: Set<number>;
}

/** A property read whose opaque seed an own-cell edge may replace. */
interface DeferredOwnSlotRead {
	readonly base: number;
	readonly key: number;
	readonly result: number;
}

/** No allocation has been observed in a cell yet. */
const ORIGIN_BOTTOM = 0;
/** More than one allocation, or a producer this analysis cannot attribute. */
const ORIGIN_TOP = -1;

/**
 * Solve the program's callee-target lattice.
 *
 * Nodes are SSA values, compiler-owned global slots, captured closure slots, one
 * return cell per function, and one cell per own data slot of a fresh aggregate
 * this graph contains; edges run producer to consumer. Every node's target state
 * can rise at most `CORE_CALLEE_TARGET_CAP + 2` times (the set grows, then widens,
 * then opens), and every call site activates at most `CORE_CALLEE_TARGET_CAP + 2`
 * return-cell edges or open raises, so the whole solve is
 * O(cap * (nodes + edges + calls)) — near-linear in program size for the fixed
 * cap, with no round over calls or functions.
 *
 * Own cells need a second, three-point component on the same graph: which single
 * allocation a node can hold. It is solved first, over the same edges, so it costs
 * one extra pass of the same shape; the containment sweep that reads it is one
 * more pass over the instructions. Both are skipped entirely when the program
 * declares no aggregate layout this analysis models.
 */
export function analyzeCoreCalleeTargets(
	program: CoreProgram,
	registry: CoreOpcodeRegistry = coreOpcodeRegistry,
	context?: CoreCompilationContext,
): CoreCalleeTargetAnalysis {
	const census = censusSlotAccesses(program, registry);
	const stableCells = singleAssignmentCellsFromCensus(program, census, context);
	const cellForString = coreOwnCellResolver(program.stringConstants);
	const valueBase: Array<number | undefined> = [];
	const valueLimit: Array<number | undefined> = [];
	const globalNodes = new Map<number, number>();
	const capturedNodes = new Map<string, number>();
	const returnNodes: Array<number | undefined> = [];
	const ownCellNodes = new Map<string, number>();
	const functionsByIndex: Array<CoreProgram["functions"][number] | undefined> = [];
	for (const fn of program.functions) functionsByIndex[fn.functionIndex] = fn;
	let nodeCount = 0;
	for (const fn of program.functions) {
		// Take the maximum rather than the last entry: a value id outside this
		// function's node range would silently alias another function's values.
		let limit = 0;
		for (const { id } of fn.values) limit = Math.max(limit, id + 1);
		valueBase[fn.functionIndex] = nodeCount;
		valueLimit[fn.functionIndex] = limit;
		nodeCount += limit;
		// Allocated for every function up front: a call site discovered mid-solve
		// must find its target's cell without growing the node universe.
		returnNodes[fn.functionIndex] = nodeCount++;
	}
	// Keep every node-indexed table dense. Growing an empty JavaScript array by
	// first assigning a high SSA node turns these hot tables into sparse/dictionary
	// storage; the closed compiler graph starts with hundreds of thousands of value
	// nodes before the first seed or edge is recorded. Append one slot whenever the
	// analysis adds a non-value node so all later indexed reads stay fast as well.
	const dependents = new Array<Array<number> | undefined>(nodeCount).fill(undefined);
	const seeds = new Array<CoreCalleeTargets | undefined>(nodeCount).fill(undefined);
	const originSeeds = new Array<number | undefined>(nodeCount).fill(undefined);
	const callSites = new Array<Array<CallResultSite> | undefined>(nodeCount).fill(
		undefined,
	);
	const constructorMethodSites = new Array<Array<ConstructorMethodSite> | undefined>(
		nodeCount,
	).fill(undefined);
	const allocateNode = (): number => {
		const node = nodeCount++;
		dependents.push(undefined);
		seeds.push(undefined);
		originSeeds.push(undefined);
		callSites.push(undefined);
		constructorMethodSites.push(undefined);
		return node;
	};
	const globalNode = (slot: number): number => {
		let node = globalNodes.get(slot);
		if (node === undefined) {
			node = allocateNode();
			globalNodes.set(slot, node);
		}
		return node;
	};
	const capturedNode = (owner: number, index: number): number => {
		const key = capturedSlotKey(owner, index);
		let node = capturedNodes.get(key);
		if (node === undefined) {
			node = allocateNode();
			capturedNodes.set(key, node);
		}
		return node;
	};
	const slotCellNode = (cell: SlotCell): number =>
		cell.kind === "global" ? globalNode(cell.slot) : capturedNode(cell.owner, cell.index);
	const stableSlotCell = (cell: SlotCell): boolean =>
		cell.kind === "global"
			? stableCells.globalSlot(cell.slot)
			: stableCells.capturedSlot(cell.owner, cell.index);

	const allocations: Array<TrackedAllocation> = [];
	const deferredReads: Array<DeferredOwnSlotRead> = [];
	const predecessors: Array<ReturnType<typeof corePredecessorEdges> | undefined> = [];
	let edges = 0;
	let callActivations = 0;
	const addEdge = (from: number, to: number): void => {
		const existing = dependents[from];
		if (existing === undefined) dependents[from] = [to];
		else existing.push(to);
		edges++;
	};
	const addSeed = (node: number, targets: CoreCalleeTargets): void => {
		const existing = seeds[node];
		seeds[node] =
			existing === undefined ? targets : joinCoreCalleeTargets(existing, targets);
	};
	const addOriginSeed = (node: number, origin: number): void => {
		const existing = originSeeds[node];
		originSeeds[node] =
			existing === undefined || existing === origin ? origin : ORIGIN_TOP;
	};
	const addCallSite = (callee: number, result: number, construct: boolean): void => {
		const site: CallResultSite = {
			callee,
			result,
			construct,
			activated: new Set(),
			openRaised: "none",
		};
		const existing = callSites[callee];
		if (existing === undefined) callSites[callee] = [site];
		else existing.push(site);
	};
	const addConstructorMethodSite = (
		callee: number,
		result: number,
		key: number,
	): void => {
		const site: ConstructorMethodSite = {
			callee,
			result,
			key,
			activated: new Set(),
		};
		const existing = constructorMethodSites[callee];
		if (existing === undefined) constructorMethodSites[callee] = [site];
		else existing.push(site);
	};

	const definitionsByFunction: Array<
		ReadonlyArray<CoreInstruction | undefined> | undefined
	> = [];
	const functionDefinitions = (
		fn: (typeof program.functions)[number],
	): ReadonlyArray<CoreInstruction | undefined> => {
		const cached = definitionsByFunction[fn.functionIndex];
		if (cached !== undefined) return cached;
		const definitions = new Array<CoreInstruction | undefined>(
			(fn.values.at(-1)?.id ?? -1) + 1,
		).fill(undefined);
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				for (const output of instruction.outputs) definitions[output] = instruction;
			}
		}
		definitionsByFunction[fn.functionIndex] = definitions;
		return definitions;
	};
	/**
	 * Own cell a key operand names. A key that is not a string constant reaching
	 * this operand through moves alone stays unresolved, which makes its base
	 * escape rather than name a cell.
	 */
	const keyResolvers = new WeakMap<
		ReadonlyArray<CoreInstruction | undefined>,
		(value: CoreValueId) => CoreOwnCell | undefined
	>();
	const operandKeyResolver = (
		definitions: ReadonlyArray<CoreInstruction | undefined>,
	) => {
		const cached = keyResolvers.get(definitions);
		if (cached !== undefined) return cached;
		const resolved = new Map<CoreValueId, CoreOwnCell | null>();
		const resolver = (value: CoreValueId): CoreOwnCell | undefined => {
			const cached = resolved.get(value);
			if (cached !== undefined) return cached ?? undefined;
			const seen = new Set<CoreValueId>();
			let current = value;
			let cell: CoreOwnCell | undefined;
			while (!seen.has(current)) {
				seen.add(current);
				const definition = definitions[current];
				if (definition === undefined) break;
				if (definition.opcode === "move" && definition.inputs.length === 1) {
					current = definition.inputs[0]!;
					continue;
				}
				if (definition.opcode === "createString") {
					const index = attributeNumber(definition, "stringIndex");
					cell = index === undefined ? undefined : cellForString(index);
				}
				break;
			}
			resolved.set(value, cell ?? null);
			return cell;
		};
		keyResolvers.set(definitions, resolver);
		return resolver;
	};
	const moveRoot = (
		definitions: ReadonlyArray<CoreInstruction | undefined>,
		initial: CoreValueId,
	): CoreValueId => {
		const seen = new Set<CoreValueId>();
		let value = initial;
		while (!seen.has(value)) {
			seen.add(value);
			const definition = definitions[value];
			if (definition?.opcode !== "move" || definition.inputs.length !== 1) break;
			value = definition.inputs[0]!;
		}
		return value;
	};
	const namespaceExportSlot = (
		definition: CoreInstruction | undefined,
		key: number,
	): number | undefined => {
		if (definition?.opcode !== "createModuleNamespace") return undefined;
		const exports = definition.attributes.exports;
		if (!Array.isArray(exports)) return undefined;
		for (const candidate of exports) {
			if (
				candidate === null ||
				typeof candidate !== "object" ||
				Array.isArray(candidate)
			) {
				continue;
			}
			const entry = candidate as CoreAttributeObject;
			const stringIndex = entry.nameStringIndex;
			const slot = entry.slot;
			const cell =
				typeof stringIndex === "number" ? cellForString(stringIndex) : undefined;
			if (
				typeof slot === "number" &&
				Number.isSafeInteger(slot) &&
				slot >= 0 &&
				cell?.kind === "object-slot" &&
				cell.key === key
			) {
				return slot;
			}
		}
		return undefined;
	};
	const callStringIndex = program.stringConstants.findIndex(
		(value) =>
			value.length === 4 &&
			value[0] === 0x63 &&
			value[1] === 0x61 &&
			value[2] === 0x6c &&
			value[3] === 0x6c,
	);
	const callCell = callStringIndex < 0 ? undefined : cellForString(callStringIndex);
	const prototypeStringIndex = program.stringConstants.findIndex(
		(value) =>
			value.length === 9 &&
			value[0] === 0x70 &&
			value[1] === 0x72 &&
			value[2] === 0x6f &&
			value[3] === 0x74 &&
			value[4] === 0x6f &&
			value[5] === 0x74 &&
			value[6] === 0x79 &&
			value[7] === 0x70 &&
			value[8] === 0x65,
	);
	const prototypeCell =
		prototypeStringIndex < 0 ? undefined : cellForString(prototypeStringIndex);
	/**
	 * Compiler-emitted method closures grouped by constructor function and static
	 * key. The innermost map deduplicates equal function indices while retaining a
	 * source node for the ordinary graph dependency.
	 *
	 * The table is deliberately advisory. Every read it serves stays opaque, so a
	 * key with more candidates than the finite cap may retain only the first cap as
	 * profitable guards without claiming they exhaust the live property value.
	 */
	const constructorMethods = new Map<number, Map<number, Map<number, number>>>();
	const eligibleBaseConstructors = new Set<number>();
	for (const target of program.functions) {
		if (
			!target.metadata.isClassConstructor ||
			target.metadata.isDerivedConstructor ||
			!target.metadata.hasPrototype ||
			target.isAsync ||
			target.isGenerator
		) {
			continue;
		}
		const definitions = functionDefinitions(target);
		let returns = 0;
		let implicitOnly = true;
		for (const block of target.blocks) {
			if (block.terminator.kind !== "return") continue;
			returns++;
			const returned = definitions[moveRoot(definitions, block.terminator.value)];
			if (returned?.opcode !== "createUndefined") {
				implicitOnly = false;
				break;
			}
		}
		if (returns > 0 && implicitOnly) eligibleBaseConstructors.add(target.functionIndex);
	}
	if (prototypeCell?.kind === "object-slot") {
		for (const setup of program.functions) {
			const base = valueBase[setup.functionIndex]!;
			const definitions = functionDefinitions(setup);
			const cellForOperand = operandKeyResolver(definitions);
			const prototypeOwners = new Map<CoreValueId, number>();
			for (const block of setup.blocks) {
				for (const instruction of block.instructions) {
					if (
						(instruction.opcode !== "loadProperty" &&
							instruction.opcode !== "loadPropertyStatic") ||
						instruction.outputs[0] === undefined ||
						instruction.inputs[0] === undefined
					) {
						continue;
					}
					const key =
						instruction.opcode === "loadPropertyStatic"
							? (() => {
									const index = attributeNumber(instruction, "stringIndex");
									return index === undefined ? undefined : cellForString(index);
								})()
							: instruction.inputs[1] === undefined
								? undefined
								: cellForOperand(instruction.inputs[1]);
					if (key === undefined || !coreOwnCellsEqual(key, prototypeCell)) continue;
					const constructor = definitions[moveRoot(definitions, instruction.inputs[0])];
					const constructorIndex =
						constructor?.opcode === "createFunction"
							? attributeNumber(constructor, "functionIndex")
							: undefined;
					if (
						constructorIndex !== undefined &&
						eligibleBaseConstructors.has(constructorIndex)
					) {
						prototypeOwners.set(instruction.outputs[0], constructorIndex);
					}
				}
			}
			for (const block of setup.blocks) {
				for (const instruction of block.instructions) {
					if (
						instruction.opcode !== "defineProperty" ||
						instruction.attributes.enumerable !== false ||
						instruction.inputs.length !== 3
					) {
						continue;
					}
					const constructorIndex = prototypeOwners.get(
						moveRoot(definitions, instruction.inputs[0]!),
					);
					const key = cellForOperand(instruction.inputs[1]!);
					if (constructorIndex === undefined || key?.kind !== "object-slot") continue;
					const methodRoot = moveRoot(definitions, instruction.inputs[2]!);
					const method = definitions[methodRoot];
					const methodIndex =
						method?.opcode === "createFunction"
							? attributeNumber(method, "functionIndex")
							: undefined;
					if (methodIndex === undefined || functionsByIndex[methodIndex] === undefined) {
						continue;
					}
					let byKey = constructorMethods.get(constructorIndex);
					if (byKey === undefined) {
						byKey = new Map();
						constructorMethods.set(constructorIndex, byKey);
					}
					let candidates = byKey.get(key.key);
					if (candidates === undefined) {
						candidates = new Map();
						byKey.set(key.key, candidates);
					}
					if (candidates.has(methodIndex) || candidates.size >= CORE_CALLEE_TARGET_CAP) {
						continue;
					}
					candidates.set(methodIndex, base + instruction.inputs[2]!);
				}
			}
		}
	}

	for (const fn of program.functions) {
		const base = valueBase[fn.functionIndex]!;
		const valueNode = (value: CoreValueId): number => base + value;
		const definitions = functionDefinitions(fn);
		const cellForOperand = operandKeyResolver(definitions);
		const functionCallReceiver = (
			instruction: CoreInstruction,
		): CoreValueId | undefined => {
			if (
				instruction.opcode !== "call" ||
				instruction.inputs.length < 2 ||
				callCell?.kind !== "object-slot"
			) {
				return undefined;
			}
			const callee = instruction.inputs[0]!;
			const thisValue = instruction.inputs[1]!;
			const definition = definitions[moveRoot(definitions, callee)];
			if (
				definition?.opcode !== "loadPropertyStatic" &&
				definition?.opcode !== "loadProperty"
			) {
				return undefined;
			}
			const receiver = definition.inputs[0];
			if (
				receiver === undefined ||
				moveRoot(definitions, receiver) !== moveRoot(definitions, thisValue)
			) {
				return undefined;
			}
			const key =
				definition.opcode === "loadPropertyStatic"
					? attributeNumber(definition, "stringIndex")
					: definition.inputs[1] === undefined
						? undefined
						: (() => {
								const keyDefinition =
									definitions[moveRoot(definitions, definition.inputs[1])];
								return keyDefinition?.opcode === "createString"
									? attributeNumber(keyDefinition, "stringIndex")
									: undefined;
							})();
			const keyCell = key === undefined ? undefined : cellForString(key);
			return keyCell?.kind === "object-slot" && keyCell.key === callCell.key
				? receiver
				: undefined;
		};
		const keyCell =
			(instruction: CoreInstruction) =>
			(access: CoreOpcodeAccess): CoreOwnCell | undefined =>
				declaredAccessKeyCell(instruction, access, cellForString, cellForOperand);
		// Incoming arguments are supplied by callers this pass does not resolve.
		for (const parameter of fn.parameters) {
			addSeed(valueNode(parameter), CORE_CALLEE_TARGETS_OPAQUE);
			addOriginSeed(valueNode(parameter), ORIGIN_TOP);
		}
		const incomingEdges = corePredecessorEdges(fn, registry);
		predecessors[fn.functionIndex] = incomingEdges;
		for (const block of fn.blocks) {
			const incoming = incomingEdges[block.id] ?? [];
			for (const [index, parameter] of block.parameters.entries()) {
				if (parameter.role === "exception" || block.id === fn.entry) {
					addSeed(valueNode(parameter.value), CORE_CALLEE_TARGETS_OPAQUE);
					addOriginSeed(valueNode(parameter.value), ORIGIN_TOP);
					continue;
				}
				for (const edge of incoming) {
					// An exceptional edge's arguments start at the handler block's first
					// explicit parameter, past the implicit exception parameter.
					const argument =
						edge.kind === "exceptional"
							? edge.arguments[index - 1]
							: edge.arguments[index];
					if (argument === undefined) {
						addSeed(valueNode(parameter.value), CORE_CALLEE_TARGETS_OPAQUE);
						addOriginSeed(valueNode(parameter.value), ORIGIN_TOP);
						continue;
					}
					addEdge(valueNode(argument), valueNode(parameter.value));
				}
			}
			for (const instruction of block.instructions) {
				const source = instruction.inputs[0];
				const result = instruction.outputs[0];
				switch (instruction.opcode) {
					case "createFunction": {
						const target = attributeNumber(instruction, "functionIndex");
						if (result === undefined) break;
						addSeed(
							valueNode(result),
							target === undefined
								? CORE_CALLEE_TARGETS_OPAQUE
								: coreCalleeTargetsFunction(target),
						);
						addOriginSeed(valueNode(result), ORIGIN_TOP);
						continue;
					}
					// The uninitialized sentinel is neither a callable nor an allocation:
					// reading a slot that still holds it throws before any call or property
					// access can observe it, so it contributes nothing to either component.
					case "createEmpty":
						continue;
					case "move":
						if (source !== undefined && result !== undefined) {
							addEdge(valueNode(source), valueNode(result));
							continue;
						}
						break;
					case "loadGlobal": {
						const slot = attributeNumber(instruction, "index");
						if (slot !== undefined && result !== undefined) {
							addEdge(globalNode(slot), valueNode(result));
							continue;
						}
						break;
					}
					case "storeGlobal": {
						const slot = attributeNumber(instruction, "index");
						if (slot !== undefined && source !== undefined) {
							addEdge(valueNode(source), globalNode(slot));
						}
						continue;
					}
					case "loadCaptured": {
						const owner = attributeNumber(instruction, "functionIndex");
						const index = attributeNumber(instruction, "index");
						if (owner !== undefined && index !== undefined && result !== undefined) {
							addEdge(capturedNode(owner, index), valueNode(result));
							continue;
						}
						break;
					}
					case "storeCaptured": {
						const owner = attributeNumber(instruction, "functionIndex");
						const index = attributeNumber(instruction, "index");
						if (owner !== undefined && index !== undefined && source !== undefined) {
							addEdge(valueNode(source), capturedNode(owner, index));
						}
						continue;
					}
					default: {
						// The registry, not a list of opcode names here, decides which
						// operand a control transfer enters and whether the result it hands
						// back is related to what the callee returned at all.
						const transfer = registry.get(instruction.opcode)?.callTransfer;
						if (transfer !== undefined && transfer.result !== "unmodeled") {
							const callee = instruction.inputs[transfer.calleeOperand];
							if (callee !== undefined && result !== undefined) {
								const flattenedReceiver = functionCallReceiver(instruction);
								if (flattenedReceiver !== undefined) {
									// The live method is still checked against the realm's retained
									// %Function.prototype.call%. Its mismatch path may return anything,
									// so this dependency contributes guarded candidates only.
									addCallSite(valueNode(flattenedReceiver), valueNode(result), false);
									addSeed(valueNode(result), CORE_CALLEE_TARGETS_OPAQUE);
								}
								addCallSite(
									valueNode(callee),
									valueNode(result),
									transfer.result === "construct-completion",
								);
								// A callee can hand back any object, including one this graph
								// allocated and lost track of, so a call result names no
								// allocation.
								addOriginSeed(valueNode(result), ORIGIN_TOP);
								continue;
							}
							break;
						}
						if (
							instruction.opcode === "createModuleNamespace" &&
							result !== undefined &&
							allocations.length < CORE_TRACKED_ALLOCATION_CAP
						) {
							const entries = instruction.attributes.exports;
							const keys: Array<number> = [];
							const values: Array<number> = [];
							let valid = false;
							if (Array.isArray(entries)) {
								valid = entries.length <= CORE_OWN_CELL_KEY_CAP;
								for (const candidate of entries) {
									if (
										candidate === null ||
										typeof candidate !== "object" ||
										Array.isArray(candidate)
									) {
										valid = false;
										break;
									}
									const entry = candidate as CoreAttributeObject;
									const cell =
										typeof entry.nameStringIndex === "number"
											? cellForString(entry.nameStringIndex)
											: undefined;
									const slot = entry.slot;
									if (
										cell?.kind !== "object-slot" ||
										keys.includes(cell.key) ||
										typeof slot !== "number" ||
										!Number.isSafeInteger(slot) ||
										slot < 0
									) {
										valid = false;
										break;
									}
									keys.push(cell.key);
									values.push(globalNode(slot));
								}
							}
							if (valid) {
								const index = allocations.length;
								allocations.push({
									functionIndex: fn.functionIndex,
									instruction: instruction.id,
									immutable: true,
									keys,
									initialValues: values,
									owned: new Set(keys),
								});
								addSeed(valueNode(result), CORE_CALLEE_TARGETS_OPAQUE);
								addOriginSeed(valueNode(result), index + 1);
								continue;
							}
						}
						const allocation = registry.get(instruction.opcode)?.allocation;
						if (allocation !== undefined && result !== undefined) {
							const layout = namedSlotLayout(instruction, allocation, cellForString);
							if (
								layout !== undefined &&
								allocations.length < CORE_TRACKED_ALLOCATION_CAP
							) {
								const index = allocations.length;
								allocations.push({
									functionIndex: fn.functionIndex,
									instruction: instruction.id,
									immutable: false,
									keys: layout.keys,
									initialValues: layout.values.map(valueNode),
									owned: new Set(layout.keys),
								});
								// A plain object is not a callable this analysis can name, so its
								// target component stays open exactly as any other producer's.
								addSeed(valueNode(result), CORE_CALLEE_TARGETS_OPAQUE);
								addOriginSeed(valueNode(result), index + 1);
								continue;
							}
						}
						// A read of one named own data slot may become an edge from that cell
						// once containment is known, so its opaque seed waits for the answer.
						const roles = operandRoles(instruction, registry, keyCell(instruction));
						const readBase = ownSlotReadBase(instruction, roles);
						if (readBase !== undefined && result !== undefined) {
							const namespaceSlot = namespaceExportSlot(
								definitions[moveRoot(definitions, readBase.base)],
								readBase.key,
							);
							if (namespaceSlot !== undefined) {
								addEdge(globalNode(namespaceSlot), valueNode(result));
								addOriginSeed(valueNode(result), ORIGIN_TOP);
								continue;
							}
							const baseDefinition = definitions[moveRoot(definitions, readBase.base)];
							if (
								baseDefinition?.opcode === "construct" &&
								baseDefinition.inputs[0] !== undefined
							) {
								addConstructorMethodSite(
									valueNode(baseDefinition.inputs[0]),
									valueNode(result),
									readBase.key,
								);
								// The candidate is advisory only: [[Get]] observes the live
								// prototype chain, which user code may have changed.
								addSeed(valueNode(result), CORE_CALLEE_TARGETS_OPAQUE);
								addOriginSeed(valueNode(result), ORIGIN_TOP);
								continue;
							}
							deferredReads.push({
								base: valueNode(readBase.base),
								key: readBase.key,
								result: valueNode(result),
							});
							addOriginSeed(valueNode(result), ORIGIN_TOP);
							continue;
						}
						break;
					}
				}
				// A producer this analysis does not model degrades only its own results.
				for (const output of instruction.outputs) {
					addSeed(valueNode(output), CORE_CALLEE_TARGETS_OPAQUE);
					addOriginSeed(valueNode(output), ORIGIN_TOP);
				}
			}
			// Every ordinary return contributes to the one cell a caller reads. A
			// generator's or an async function's returns land here too; what keeps a
			// caller from reading them is the coroutine rule in `activateCallSite`,
			// not a missing edge.
			if (block.terminator.kind === "return") {
				addEdge(valueNode(block.terminator.value), returnNodes[fn.functionIndex]!);
			}
		}
	}

	if (census.global) {
		for (const node of globalNodes.values()) addSeed(node, CORE_CALLEE_TARGETS_OPAQUE);
	}
	if (census.captured) {
		for (const node of capturedNodes.values()) {
			addSeed(node, CORE_CALLEE_TARGETS_OPAQUE);
		}
	}
	// A realm installer can populate another realm's global-slot array outside
	// this graph. Function indices remain useful guarded candidates, but no global
	// cell is a closed identity or a carrier of a contained allocation while realm
	// creation is enabled.
	if (context?.facts.world.realms === true) {
		for (const node of globalNodes.values()) {
			addSeed(node, CORE_CALLEE_TARGETS_OPAQUE);
			addOriginSeed(node, ORIGIN_TOP);
		}
	}
	// A family writer that does not preserve the values of the cells it covers can
	// replace any of them with something this graph never named, so no cell in that
	// family can carry an allocation identity.
	if (census.globalOverwrite) {
		for (const node of globalNodes.values()) addOriginSeed(node, ORIGIN_TOP);
	}
	if (census.capturedOverwrite) {
		for (const node of capturedNodes.values()) addOriginSeed(node, ORIGIN_TOP);
	}
	for (const slot of census.opaqueGlobalSlots) {
		addSeed(globalNode(slot), CORE_CALLEE_TARGETS_OPAQUE);
		addOriginSeed(globalNode(slot), ORIGIN_TOP);
	}
	for (const [owner, index] of census.opaqueCapturedSlots.values()) {
		addSeed(capturedNode(owner, index), CORE_CALLEE_TARGETS_OPAQUE);
		addOriginSeed(capturedNode(owner, index), ORIGIN_TOP);
	}
	// The host installs its exports into these slots, so their writers are not in
	// this graph at all.
	for (const candidate of context?.data.hostInstallCandidates ?? []) {
		for (const { slot } of candidate.exports) {
			addSeed(globalNode(slot), CORE_CALLEE_TARGETS_OPAQUE);
			addOriginSeed(globalNode(slot), ORIGIN_TOP);
		}
	}

	const origins =
		allocations.length === 0
			? undefined
			: solveAllocationOrigins(nodeCount, originSeeds, dependents);
	const contained =
		origins === undefined
			? undefined
			: containAllocations({
					program,
					registry,
					allocations,
					origins,
					valueBase,
					predecessors,
					cellForString,
					functionDefinitions,
					operandKeyResolver,
					slotCellNode,
					stableSlotCell,
				});
	const ownCellNode = (allocation: number, key: number): number => {
		const cacheKey = `${allocation}\0${key}`;
		let node = ownCellNodes.get(cacheKey);
		if (node === undefined) {
			node = allocateNode();
			ownCellNodes.set(cacheKey, node);
		}
		return node;
	};
	let containedAllocations = 0;
	if (contained !== undefined && origins !== undefined) {
		for (const [index, allocation] of allocations.entries()) {
			if (contained.escaped[index] === 0) containedAllocations += 1;
			for (const [position, key] of allocation.keys.entries()) {
				addEdge(allocation.initialValues[position]!, ownCellNode(index, key));
			}
		}
		for (const write of contained.writes) {
			addEdge(write.value, ownCellNode(write.allocation, write.key));
		}
	}
	for (const read of deferredReads) {
		const allocation = origins === undefined ? ORIGIN_TOP : origins[read.base]!;
		const tracked = allocation > 0 ? allocations[allocation - 1] : undefined;
		if (tracked !== undefined && tracked.owned.has(read.key)) {
			addEdge(ownCellNode(allocation - 1, read.key), read.result);
			if (contained?.escaped[allocation - 1] !== 0) {
				// The graph still names every initial/in-program value written to this
				// exact fresh object's slot. Escaping permits additional mutation, so
				// keep those candidates but require every consumer to retain a fallback.
				addSeed(read.result, CORE_CALLEE_TARGETS_OPAQUE);
			}
			continue;
		}
		addSeed(read.result, CORE_CALLEE_TARGETS_OPAQUE);
	}

	const state = new Array<CoreCalleeTargets>(nodeCount).fill(CORE_CALLEE_TARGETS_BOTTOM);
	const queued = new Uint8Array(nodeCount);
	const queue: Array<number> = [];
	let propagations = 0;
	const raise = (node: number, targets: CoreCalleeTargets): void => {
		const next = joinCoreCalleeTargets(state[node]!, targets);
		if (coreCalleeTargetsEqual(state[node]!, next)) return;
		state[node] = next;
		propagations++;
		if (queued[node] === 0) {
			queued[node] = 1;
			queue.push(node);
		}
	};
	/**
	 * Wire what one call site has learned from its callee cell.
	 *
	 * The rules follow [[Call]] and [[Construct]], not the call syntax:
	 *
	 * - An opaque callee contributes an opaque result while finite named callees
	 *   still contribute their return cells. This preserves guarded candidates and
	 *   their fallback. A callee widened to `anyScript` has lost those bounded
	 *   candidates, so its result goes to top without enumerating every function.
	 * - A generator or async target returns its coroutine's promise, generator, or
	 *   async-generator object, never the value its body returns, and none of those
	 *   objects is callable — so it contributes nothing. The body's return value
	 *   reaches a consumer only through `await` or `iteratorNext`, whose results
	 *   this analysis leaves opaque.
	 * - `new` on a derived constructor completes with the object its own `super()`
	 *   bound as `this` whenever the body returns anything that is not an object.
	 *   No Core value names that object, so an opaque alternative accompanies its
	 *   explicit return targets.
	 * - Otherwise the result is the target's return cell. For [[Construct]] that
	 *   covers the one callable case — an explicitly returned function object —
	 *   because the object [[Construct]] creates for an ordinary constructor is a
	 *   plain object and can never be called.
	 * - A target outside this program is not a cell at all, so it is open.
	 */
	const activateCallSite = (site: CallResultSite): void => {
		const callee = state[site.callee]!;
		if (callee.anyScript) {
			if (site.openRaised === "top") return;
			site.openRaised = "top";
			callActivations++;
			raise(site.result, CORE_CALLEE_TARGETS_TOP);
			return;
		}
		if (callee.opaque && site.openRaised === "none") {
			site.openRaised = "opaque";
			callActivations++;
			raise(site.result, CORE_CALLEE_TARGETS_OPAQUE);
		}
		for (const target of callee.functions) {
			if (site.activated.has(target)) continue;
			site.activated.add(target);
			callActivations++;
			const targetFunction = functionsByIndex[target];
			if (targetFunction === undefined) {
				raise(site.result, CORE_CALLEE_TARGETS_OPAQUE);
				continue;
			}
			if (targetFunction.isGenerator || targetFunction.isAsync) continue;
			if (site.construct && targetFunction.metadata.isDerivedConstructor) {
				raise(site.result, CORE_CALLEE_TARGETS_OPAQUE);
			}
			const returnNode = returnNodes[target]!;
			addEdge(returnNode, site.result);
			raise(site.result, state[returnNode]!);
		}
	};
	const activateConstructorMethodSite = (site: ConstructorMethodSite): void => {
		const callee = state[site.callee]!;
		if (callee.anyScript) return;
		for (const target of callee.functions) {
			if (site.activated.has(target)) continue;
			site.activated.add(target);
			for (const source of constructorMethods.get(target)?.get(site.key)?.values() ??
				[]) {
				// This dependency is discovered after seeds have been installed, so
				// propagate the source's current state as well as wiring future rises.
				addEdge(source, site.result);
				raise(site.result, state[source]!);
			}
		}
	};

	for (let node = 0; node < seeds.length; node++) {
		const targets = seeds[node];
		if (targets !== undefined) raise(node, targets);
	}
	while (queue.length > 0) {
		const node = queue.pop()!;
		queued[node] = 0;
		const targets = state[node]!;
		for (const dependent of dependents[node] ?? []) raise(dependent, targets);
		for (const site of callSites[node] ?? []) activateCallSite(site);
		for (const site of constructorMethodSites[node] ?? []) {
			activateConstructorMethodSite(site);
		}
	}

	return {
		targets(functionIndex: number, value: CoreValueId): CoreCalleeTargets {
			const base = valueBase[functionIndex];
			if (base === undefined || value >= valueLimit[functionIndex]!) {
				return CORE_CALLEE_TARGETS_BOTTOM;
			}
			return state[base + value] ?? CORE_CALLEE_TARGETS_BOTTOM;
		},
		globalSlot(slot: number): CoreCalleeTargets {
			const node = globalNodes.get(slot);
			return node === undefined ? CORE_CALLEE_TARGETS_BOTTOM : state[node]!;
		},
		capturedSlot(owner: number, index: number): CoreCalleeTargets {
			const node = capturedNodes.get(capturedSlotKey(owner, index));
			return node === undefined ? CORE_CALLEE_TARGETS_BOTTOM : state[node]!;
		},
		returnTargets(functionIndex: number): CoreCalleeTargets {
			const node = returnNodes[functionIndex];
			return node === undefined ? CORE_CALLEE_TARGETS_BOTTOM : state[node]!;
		},
		statistics: {
			nodes: nodeCount,
			edges,
			propagations,
			callActivations,
			trackedAllocations: allocations.length,
			containedAllocations,
			ownCellNodes: ownCellNodes.size,
			singleAssignmentCells: stableCells.count,
		},
	};
}

/**
 * The one base operand a property read names, when the instruction is exactly one
 * read of one named own data slot. Anything else — a write, a shape edit, two
 * accesses, an unresolvable key, more than one result — is not a read this
 * analysis can replace with a cell edge.
 */
function ownSlotReadBase(
	instruction: CoreInstruction,
	roles: ReadonlyMap<number, OperandRole>,
): { readonly base: CoreValueId; readonly key: number } | undefined {
	if (instruction.outputs.length !== 1) return undefined;
	let found: { readonly base: CoreValueId; readonly key: number } | undefined;
	for (const [operand, role] of roles) {
		if (role.kind !== "own-slot") continue;
		if (role.mode !== "read" || found !== undefined) return undefined;
		const base = instruction.inputs[operand];
		if (base === undefined) return undefined;
		found = { base, key: role.key };
	}
	return found;
}

/**
 * Which single allocation each node can hold, over the same graph and the same
 * monotone worklist as the target component.
 *
 * The lattice is three points high — nothing observed, one allocation, or an
 * unattributable producer — so this costs one pass of the same shape as the
 * target solve. Exactly one allocation is a must-alias answer, because every
 * producer this analysis does not model seeds the top.
 */
function solveAllocationOrigins(
	nodeCount: number,
	originSeeds: ReadonlyArray<number | undefined>,
	dependents: ReadonlyArray<ReadonlyArray<number> | undefined>,
): Int32Array {
	const origins = new Int32Array(nodeCount);
	const queued = new Uint8Array(nodeCount);
	const queue: Array<number> = [];
	const raise = (node: number, origin: number): void => {
		if (origin === ORIGIN_BOTTOM) return;
		const current = origins[node]!;
		const next =
			current === ORIGIN_BOTTOM ? origin : current === origin ? current : ORIGIN_TOP;
		if (next === current) return;
		origins[node] = next;
		if (queued[node] === 0) {
			queued[node] = 1;
			queue.push(node);
		}
	};
	for (let node = 0; node < originSeeds.length; node++) {
		const origin = originSeeds[node];
		if (origin !== undefined) raise(node, origin);
	}
	while (queue.length > 0) {
		const node = queue.pop()!;
		queued[node] = 0;
		const origin = origins[node]!;
		for (const dependent of dependents[node] ?? []) raise(dependent, origin);
	}
	return origins;
}

interface OwnCellWrite {
	readonly allocation: number;
	readonly key: number;
	readonly value: number;
}

interface ContainmentInput {
	readonly program: CoreProgram;
	readonly registry: CoreOpcodeRegistry;
	readonly allocations: ReadonlyArray<TrackedAllocation>;
	readonly origins: Int32Array;
	readonly valueBase: ReadonlyArray<number | undefined>;
	readonly predecessors: ReadonlyArray<
		ReturnType<typeof corePredecessorEdges> | undefined
	>;
	readonly cellForString: (index: number) => CoreOwnCell | undefined;
	readonly functionDefinitions: (
		fn: CoreProgram["functions"][number],
	) => ReadonlyArray<CoreInstruction | undefined>;
	readonly operandKeyResolver: (
		definitions: ReadonlyArray<CoreInstruction | undefined>,
	) => (value: CoreValueId) => CoreOwnCell | undefined;
	readonly slotCellNode: (cell: SlotCell) => number;
	readonly stableSlotCell: (cell: SlotCell) => boolean;
}

/**
 * Decide, for every tracked allocation, whether this graph contains every
 * operation that can reach it, and collect the writes to its own cells.
 *
 * An allocation stays contained only while every use of a value that must hold it
 * is one of: an inspection that retains nothing, a read or write of one of its own
 * declared data slots, a store into a compiler-owned cell whose whole traffic this
 * graph contains, or a control-flow edge whose destination still holds only this
 * allocation. Returning it, throwing it, handing it to a call — as an argument or
 * as the receiver a method call passes — editing its shape, replacing its
 * prototype, or naming a key outside its layout all make it reachable from code
 * this graph does not enumerate, so its cells stop being knowable.
 *
 * That is what excludes the whole surprise surface at once: a Proxy or an accessor
 * would have to be installed through an escaping reference or a shape edit, a
 * prototype lookup cannot happen because every declared key of a named-slot
 * literal is an own data property, and reflection needs a call.
 */
function containAllocations(input: ContainmentInput): {
	readonly escaped: Uint8Array;
	readonly writes: ReadonlyArray<OwnCellWrite>;
} {
	const { allocations, origins, registry } = input;
	const escaped = new Uint8Array(allocations.length);
	const writes: Array<OwnCellWrite> = [];
	const escapeNode = (node: number): void => {
		const origin = origins[node]!;
		if (origin > 0 && allocations[origin - 1]?.immutable !== true) {
			escaped[origin - 1] = 1;
		}
	};
	for (const fn of input.program.functions) {
		const base = input.valueBase[fn.functionIndex]!;
		const valueNode = (value: CoreValueId): number => base + value;
		const definitions = input.functionDefinitions(fn);
		const cellForOperand = input.operandKeyResolver(definitions);
		const predecessors = input.predecessors[fn.functionIndex]!;
		for (const block of fn.blocks) {
			// A handler argument is live on a path this sweep does not model, so it
			// leaves the allocation reachable from a frame the graph does not follow.
			for (const argument of block.handler?.arguments ?? []) {
				escapeNode(valueNode(argument));
			}
			for (const edge of predecessors[block.id] ?? []) {
				if (edge.kind === "exceptional") continue;
				for (const [position, argument] of edge.arguments.entries()) {
					const node = valueNode(argument);
					const parameter = block.parameters[position];
					// A join that does not collapse to this allocation loses its identity:
					// later uses of the parameter are no longer attributable.
					if (
						parameter === undefined ||
						origins[valueNode(parameter.value)] !== origins[node]
					) {
						escapeNode(node);
					}
				}
			}
			for (const instruction of block.instructions) {
				const roles = operandRoles(
					instruction,
					registry,
					(access: CoreOpcodeAccess): CoreOwnCell | undefined =>
						declaredAccessKeyCell(
							instruction,
							access,
							input.cellForString,
							cellForOperand,
						),
				);
				for (const [operand, value] of instruction.inputs.entries()) {
					const node = valueNode(value);
					const origin = origins[node]!;
					if (origin <= 0) continue;
					const allocation = allocations[origin - 1]!;
					if (allocation.immutable) continue;
					const role = roles.get(operand) ?? OPERAND_ESCAPE;
					switch (role.kind) {
						case "observed":
							break;
						case "own-slot": {
							if (!allocation.owned.has(role.key)) {
								escaped[origin - 1] = 1;
								break;
							}
							if (role.mode !== "write") break;
							const stored =
								role.valueOperand === undefined
									? undefined
									: instruction.inputs[role.valueOperand];
							if (stored === undefined) escaped[origin - 1] = 1;
							else {
								writes.push({
									allocation: origin - 1,
									key: role.key,
									value: valueNode(stored),
								});
							}
							break;
						}
						case "cell-store":
							if (
								!input.stableSlotCell(role.cell) ||
								origins[input.slotCellNode(role.cell)] !== origin
							) {
								escaped[origin - 1] = 1;
							}
							break;
						case "escape":
							escaped[origin - 1] = 1;
							break;
					}
				}
			}
			const terminator = block.terminator;
			// A branch, switch, or guard condition tests the reference without
			// retaining it, so only a completion value leaves here.
			if (terminator.kind === "return" || terminator.kind === "throw") {
				escapeNode(valueNode(terminator.value));
			}
		}
	}
	return { escaped, writes };
}

/**
 * Instruction attribute carrying a call site's bounded target set.
 *
 * Core-internal: target lowering consumes a closed call target as an exact
 * `directFunctionIndex`; open finite target sets remain guard/fallback facts.
 * This complete lattice state is dropped rather than lowered or serialized.
 */
export const CORE_CALLEE_TARGETS_ATTRIBUTE = "calleeTargets";

/** Attributes this analysis owns that never cross the Core-to-target boundary. */
export const CORE_INTERNAL_TARGET_ATTRIBUTES: ReadonlySet<string> = new Set([
	CORE_CALLEE_TARGETS_ATTRIBUTE,
]);

/**
 * Attribute form of a target set. Both loss bits are recorded so a later
 * consumer can tell a closed proof from a speculation without re-running the
 * analysis.
 */
export function coreCalleeTargetsAttribute(
	targets: CoreCalleeTargets,
): CoreAttributeObject {
	return {
		functions: [...targets.functions],
		anyScript: targets.anyScript,
		opaque: targets.opaque,
	};
}
