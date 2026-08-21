/**
 * Core's memory model: abstract locations, alias partitions, and an analysis-only
 * memory-SSA versioning of those partitions.
 *
 * Locations come from the opcode registry's declared accesses, never from a
 * per-pass opcode switch. Activation and program slots are named exactly, so a
 * write to one slot leaves every other slot's version alone. A heap access is
 * named exactly only when a caller supplies a resolution that proves its base and
 * key address one allocation's own data slot; otherwise the access covers its
 * whole family, so its invalidation still flows through the shared effect
 * domains.
 *
 * Two things deliberately absent: strings, whose values are immutable so there is
 * no string cell to alias, and epochs, whose validity belongs to the fact system.
 */

import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import { coreInstructionEffects, coreOpcodeRegistry } from "./core-ir-opcodes.ts";
import type { CoreAccessKey, CoreOwnCell } from "./core-ir-provenance.ts";
import {
	CORE_EFFECT_DOMAINS,
	CORE_MEMORY_FAMILIES,
	CORE_MEMORY_FAMILY_DOMAINS,
} from "./core-ir.ts";
import type {
	CoreAccessMode,
	CoreEffectDomain,
	CoreFunction,
	CoreInstruction,
	CoreInstructionEffects,
	CoreInstructionId,
	CoreMemoryFamily,
	CoreOpcodeAccess,
	CoreOpcodeRegistry,
	CoreValueId,
} from "./core-ir.ts";

/**
 * An exactly named cell, or a whole family when the access cannot name one. Only
 * exact locations may carry a value between two program points; a family
 * location exists so its invalidation is still modelled.
 */
export type CoreMemoryLocation =
	| { readonly kind: "global-slot"; readonly slot: number }
	| { readonly kind: "local-slot"; readonly slot: number }
	| { readonly kind: "captured-slot"; readonly owner: number; readonly index: number }
	| { readonly kind: "activation-this" }
	| {
			readonly kind: "object-slot";
			readonly allocation: CoreInstructionId;
			readonly key: number;
	  }
	| {
			readonly kind: "element";
			readonly allocation: CoreInstructionId;
			readonly index: number;
	  }
	| { readonly kind: "family"; readonly family: CoreMemoryFamily };

export type CoreExactMemoryLocation = Exclude<
	CoreMemoryLocation,
	{ readonly kind: "family" }
>;

/** Interned alias partition. Equality is the only operation callers need. */
export type CoreMemoryPartition = string & {
	readonly __coreMemoryPartition: unique symbol;
};

/**
 * Analysis-only memory-SSA version identity of one partition at one point.
 *
 * Versions are dense integers private to one `coreMemoryVersions` result; two
 * versions are the same definition exactly when they are numerically equal.
 * Never compare versions taken from two different results.
 */
export type CoreMemoryVersion = number & {
	readonly __coreMemoryVersion: unique symbol;
};

export function coreMemoryLocationFamily(location: CoreMemoryLocation): CoreMemoryFamily {
	return location.kind === "family" ? location.family : location.kind;
}

export function coreMemoryLocationIsExact(
	location: CoreMemoryLocation,
): location is CoreExactMemoryLocation {
	return location.kind !== "family";
}

export function coreMemoryPartition(
	location: CoreExactMemoryLocation,
): CoreMemoryPartition {
	switch (location.kind) {
		case "global-slot":
			return `slot\0global-slot\0${location.slot}` as CoreMemoryPartition;
		case "local-slot":
			return `slot\0local-slot\0${location.slot}` as CoreMemoryPartition;
		case "captured-slot":
			return `slot\0captured-slot\0${location.owner}\0${location.index}` as CoreMemoryPartition;
		case "activation-this":
			return "slot\0activation-this" as CoreMemoryPartition;
		case "object-slot":
			return `slot\0object-slot\0${location.allocation}\0${location.key}` as CoreMemoryPartition;
		case "element":
			return `slot\0element\0${location.allocation}\0${location.index}` as CoreMemoryPartition;
	}
}

/** Partition standing for every cell an effect domain covers. */
export function coreMemoryDomainPartition(domain: CoreEffectDomain): CoreMemoryPartition {
	return `domain\0${domain}` as CoreMemoryPartition;
}

/**
 * Proof supplier for heap locations. Naming an exact object slot requires knowing
 * that the base must-aliases one allocation and that the key is one of its own
 * writable data slots; that knowledge is a whole-function analysis, so the memory
 * model takes it as an argument instead of guessing.
 *
 * Contract: a resolution may only name a slot exactly when no code outside this
 * function can hold a reference to the allocation. The memory model relies on it —
 * an exactly named object slot survives effects it cannot attribute to a base,
 * because nothing an unknown call or a suspension runs can reach a reference this
 * activation never handed out. Naming a slot on a reference that escapes would
 * make every such effect silently invisible to it.
 */
export interface CoreMemoryResolution {
	ownCell(
		base: CoreValueId,
		key: CoreAccessKey,
		mode: CoreAccessMode,
	): { readonly allocation: CoreInstructionId; readonly cell: CoreOwnCell } | undefined;
}

export interface CoreMemoryAccess {
	readonly mode: CoreAccessMode;
	readonly location: CoreMemoryLocation;
	/** Declared heap base, when the descriptor names one. */
	readonly base?: CoreValueId;
	readonly key?: CoreAccessKey;
	/** Value a write stores; the forwarding source for a later read. */
	readonly value?: CoreValueId;
	/** Value a read produces; the redundancy target. */
	readonly result?: CoreValueId;
}

const DOMAIN_BIT: ReadonlyMap<CoreEffectDomain, number> = new Map(
	CORE_EFFECT_DOMAINS.map((domain, index) => [domain, 1 << index]),
);

function domainMask(domains: ReadonlyArray<CoreEffectDomain>): number {
	let mask = 0;
	for (const domain of domains) mask |= DOMAIN_BIT.get(domain) ?? 0;
	return mask;
}

const FAMILY_DOMAIN_MASK: Readonly<Record<CoreMemoryFamily, number>> = Object.freeze(
	Object.fromEntries(
		CORE_MEMORY_FAMILIES.map((family) => [
			family,
			domainMask(CORE_MEMORY_FAMILY_DOMAINS[family]),
		]),
	) as Record<CoreMemoryFamily, number>,
);

interface EffectMasks {
	readonly reads: number;
	readonly writes: number;
}

/**
 * Effect summaries are shared objects — a refinement-free instruction reuses its
 * opcode's frozen summary — so masking them once per distinct summary removes the
 * domain-name lookups from every analysis walk.
 */
const effectMaskCache = new WeakMap<CoreInstructionEffects, EffectMasks>();

function instructionEffectMasks(effects: CoreInstructionEffects): EffectMasks {
	let masks = effectMaskCache.get(effects);
	if (masks === undefined) {
		masks = { reads: domainMask(effects.reads), writes: domainMask(effects.writes) };
		effectMaskCache.set(effects, masks);
	}
	return masks;
}

const NO_ACCESSES: ReadonlyArray<CoreOpcodeAccess> = Object.freeze([]);

function accessIsEffective(access: CoreOpcodeAccess, masks: EffectMasks): boolean {
	const effective = access.mode === "read" ? masks.reads : masks.writes;
	return (FAMILY_DOMAIN_MASK[access.family] & effective) !== 0;
}

/**
 * Declared accesses a verified effect refinement did not remove, so a refinement
 * narrows the location model in exactly the same step as it narrows the effect
 * summary. The unrefined case returns the registry's own array unchanged.
 */
function effectiveAccesses(
	instruction: CoreInstruction,
	registry: CoreOpcodeRegistry = coreOpcodeRegistry,
): ReadonlyArray<CoreOpcodeAccess> {
	const declared = registry.require(instruction.opcode).accesses;
	if (declared === undefined || declared.length === 0) return NO_ACCESSES;
	const masks = instructionEffectMasks(coreInstructionEffects(instruction, registry));
	let kept = 0;
	for (const access of declared) if (accessIsEffective(access, masks)) kept += 1;
	if (kept === declared.length) return declared;
	if (kept === 0) return NO_ACCESSES;
	const effective: Array<CoreOpcodeAccess> = [];
	for (const access of declared)
		if (accessIsEffective(access, masks)) effective.push(access);
	return effective;
}

function integerAttribute(
	instruction: CoreInstruction,
	name: string,
): number | undefined {
	const value = instruction.attributes[name];
	return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function declaredAccessKey(
	access: CoreOpcodeAccess,
	instruction: CoreInstruction,
): CoreAccessKey | undefined {
	if (access.keyAttribute !== undefined) {
		const index = integerAttribute(instruction, access.keyAttribute);
		return index === undefined ? undefined : { kind: "string-constant", index };
	}
	if (access.keyOperand !== undefined) {
		const value = instruction.inputs[access.keyOperand];
		return value === undefined ? undefined : { kind: "operand", value };
	}
	return undefined;
}

/**
 * Resolve an access to an exact cell, or to nothing when the instruction does not
 * carry the attributes the descriptor promised. A malformed attribute degrades to
 * the whole family, never to a narrower guess.
 */
function exactLocation(
	access: CoreOpcodeAccess,
	instruction: CoreInstruction,
	resolution: CoreMemoryResolution | undefined,
): CoreExactMemoryLocation | undefined {
	const attributes = access.attributes ?? [];
	switch (access.family) {
		case "object-slot": {
			if (resolution === undefined || access.baseOperand === undefined) return undefined;
			const base = instruction.inputs[access.baseOperand];
			const key = declaredAccessKey(access, instruction);
			if (base === undefined || key === undefined) return undefined;
			const resolved = resolution.ownCell(base, key, access.mode);
			if (resolved === undefined) return undefined;
			return resolved.cell.kind === "element"
				? {
						kind: "element",
						allocation: resolved.allocation,
						index: resolved.cell.index,
					}
				: {
						kind: "object-slot",
						allocation: resolved.allocation,
						key: resolved.cell.key,
					};
		}
		case "activation-this":
			return { kind: "activation-this" };
		case "global-slot":
		case "local-slot": {
			const slot =
				attributes.length === 1
					? integerAttribute(instruction, attributes[0]!)
					: undefined;
			return slot === undefined ? undefined : { kind: access.family, slot };
		}
		case "captured-slot": {
			if (attributes.length !== 2) return undefined;
			const owner = integerAttribute(instruction, attributes[0]!);
			const index = integerAttribute(instruction, attributes[1]!);
			return owner === undefined || index === undefined
				? undefined
				: { kind: "captured-slot", owner, index };
		}
		default:
			return undefined;
	}
}

/** Memory one instruction touches, in declaration order. */
export function coreMemoryAccesses(
	instruction: CoreInstruction,
	resolution?: CoreMemoryResolution,
	registry: CoreOpcodeRegistry = coreOpcodeRegistry,
): ReadonlyArray<CoreMemoryAccess> {
	const declared = effectiveAccesses(instruction, registry);
	if (declared.length === 0) return [];
	const accesses: Array<CoreMemoryAccess> = [];
	for (const access of declared) {
		const base =
			access.baseOperand === undefined
				? undefined
				: instruction.inputs[access.baseOperand];
		const value =
			access.valueOperand === undefined
				? undefined
				: instruction.inputs[access.valueOperand];
		const key = declaredAccessKey(access, instruction);
		accesses.push({
			mode: access.mode,
			location:
				exactLocation(access, instruction, resolution) ??
				({ kind: "family", family: access.family } as const),
			...(base === undefined ? {} : { base }),
			...(key === undefined ? {} : { key }),
			...(value === undefined ? {} : { value }),
			...(access.mode === "read" && instruction.outputs.length === 1
				? { result: instruction.outputs[0]! }
				: {}),
		});
	}
	return accesses;
}

/**
 * More exactly read cells than this in one family stop earning their precision, so
 * the family collapses to its domain partitions. Only read cells count: a cell no
 * instruction reads is never versioned and never appears in an invalidation set,
 * so it costs the solver nothing and must not push a family over the bound. The
 * bound keeps the per-instruction invalidation set, and therefore the whole
 * analysis, linear in the instruction count for any function.
 */
const MAX_EXACT_PARTITIONS_PER_FAMILY = 256;
const CONTAINED_MEMORY_FAMILIES: ReadonlySet<CoreMemoryFamily> = new Set([
	"object-slot",
	"element",
]);

/**
 * Families whose exactly read cells still fit under the precision bound.
 *
 * Exact locations always report their access's own family, so the cap can be
 * decided before any partition is interned.
 */
function exactPartitionFamilies(
	fn: CoreFunction,
	resolution: CoreMemoryResolution | undefined,
): ReadonlySet<CoreMemoryFamily> {
	const counts = new Map<CoreMemoryFamily, Set<CoreMemoryPartition>>();
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			for (const access of effectiveAccesses(instruction)) {
				if (access.mode !== "read") continue;
				let partitions = counts.get(access.family);
				if (partitions === undefined) {
					partitions = new Set();
					counts.set(access.family, partitions);
				} else if (partitions.size > MAX_EXACT_PARTITIONS_PER_FAMILY) {
					continue;
				}
				const location = exactLocation(access, instruction, resolution);
				if (location !== undefined) partitions.add(coreMemoryPartition(location));
			}
		}
	}
	return new Set(
		CORE_MEMORY_FAMILIES.filter(
			(family) => (counts.get(family)?.size ?? 0) <= MAX_EXACT_PARTITIONS_PER_FAMILY,
		),
	);
}

export interface CoreMemoryVersions {
	/**
	 * Value-numbering key over every partition the instruction reads, or nothing
	 * when it reads no modelled memory.
	 */
	readKey(instruction: CoreInstructionId): string | undefined;
	/**
	 * Version of one exactly named partition the instruction reads, for
	 * store-to-load forwarding.
	 */
	readVersion(
		instruction: CoreInstructionId,
		partition: CoreMemoryPartition,
	): CoreMemoryVersion | undefined;
	/**
	 * Version an own slot of a fresh aggregate carries immediately after its
	 * allocation, so the literal's initial value can be forwarded to a later read.
	 */
	initializationVersion(
		instruction: CoreInstructionId,
		partition: CoreMemoryPartition,
	): CoreMemoryVersion | undefined;
	/**
	 * Version an instruction's exact write installs, for a following reader.
	 * Nothing when no instruction reads that partition, so no reader can observe
	 * the definition.
	 */
	writeVersion(
		instruction: CoreInstructionId,
		partition: CoreMemoryPartition,
	): CoreMemoryVersion | undefined;
}

const NO_MEMORY_VERSIONS: CoreMemoryVersions = Object.freeze({
	readKey: () => undefined,
	readVersion: () => undefined,
	initializationVersion: () => undefined,
	writeVersion: () => undefined,
});

/**
 * Where a version was defined. The kind and its owner — an instruction index for
 * a write, a block for the rest — select one stride of the version space, so
 * `(owner * VERSION_KINDS + kind) * slots + slot` is injective without an
 * interning table. Entry versions take owner and kind zero, which makes them the
 * slot numbers themselves.
 *
 * The encoding stays an exact integer because the precision bound caps a
 * function's slots at nine domains plus `MAX_EXACT_PARTITIONS_PER_FAMILY` per
 * family: a version exceeds `Number.MAX_SAFE_INTEGER` only past roughly 7e11
 * instructions, which no representable function reaches. Raising that bound
 * without re-checking this product would be the way to break it.
 */
const VERSION_KINDS = 5;
const VERSION_ENTRY = 0;
const VERSION_WRITE = 1;
const VERSION_PHI = 2;
const VERSION_EXCEPTION = 3;
const VERSION_UNREACHABLE = 4;

/**
 * Per-instruction id lists packed into one array. A caller pushes into the
 * segment of the instruction it is building, then seals it.
 */
class PackedLists {
	readonly #offsets: Array<number> = [0];
	readonly #values: Array<number> = [];

	/** Append to the open segment, ignoring an id the segment already holds. */
	push(id: number): void {
		const start = this.#offsets[this.#offsets.length - 1]!;
		for (let index = start; index < this.#values.length; index += 1) {
			if (this.#values[index] === id) return;
		}
		this.#values.push(id);
	}

	seal(): void {
		this.#offsets.push(this.#values.length);
	}

	/** Every id in every sealed segment, in push order. */
	get allIds(): ReadonlyArray<number> {
		return this.#values;
	}

	/** Rewrite ids to state slots, dropping every partition nothing tracks. */
	toSlots(slotOf: Int32Array, sorted = false): PackedSlots {
		const offsets = new Int32Array(this.#offsets.length);
		const slots: Array<number> = [];
		for (let segment = 1; segment < this.#offsets.length; segment += 1) {
			const start = slots.length;
			for (
				let index = this.#offsets[segment - 1]!;
				index < this.#offsets[segment]!;
				index += 1
			) {
				const slot = slotOf[this.#values[index]!]!;
				if (slot >= 0) slots.push(slot);
			}
			if (sorted) insertionSort(slots, start);
			offsets[segment] = slots.length;
		}
		return { offsets, slots: Int32Array.from(slots) };
	}
}

interface PackedSlots {
	readonly offsets: Int32Array;
	readonly slots: Int32Array;
}

function insertionSort(values: Array<number>, start: number): void {
	for (let index = start + 1; index < values.length; index += 1) {
		const value = values[index]!;
		let position = index - 1;
		while (position >= start && values[position]! > value) {
			values[position + 1] = values[position]!;
			position -= 1;
		}
		values[position + 1] = value;
	}
}

function lowestSetBitIndex(mask: number): number {
	return 31 - Math.clz32(mask & -mask);
}

function sameState(left: Float64Array, right: Float64Array): boolean {
	for (let slot = 0; slot < left.length; slot += 1) {
		if (left[slot] !== right[slot]) return false;
	}
	return true;
}

/**
 * Version every partition read anywhere in the function.
 *
 * Partitions the function reads are interned to dense state slots and each block
 * state is one `Float64Array` of version numbers, so a merge, a comparison, and a
 * block transfer are all typed-array loops rather than string-keyed map traffic.
 *
 * Each (block, partition) entry version is a point in a height-three lattice:
 * unset, one concrete version, or this block's own memory phi. Joining two
 * different concrete versions yields the phi, and a phi never becomes concrete
 * again, so the transfer functions are monotone and the fixed point is reached in
 * at most two updates per (block, partition). Blocks are revisited through a
 * reverse-postorder dirty set rather than swept unconditionally: a block whose
 * predecessors all still hold the exits it last read would recompute the same
 * state, so skipping it cannot change the fixed point. An acyclic reachable CFG
 * therefore settles in a single topological pass, and a cycle only revisits the
 * blocks a changed exit actually reaches.
 *
 * Retaining the phi's *identity* is what makes a version usable as a
 * value-equality proof. A set of reaching writes is not: two points in a loop can
 * see the same set of writes while observing different ones on a single concrete
 * iteration.
 */
export function coreMemoryVersions(
	fn: CoreFunction,
	cfg: CoreControlFlow,
	resolution?: CoreMemoryResolution,
): CoreMemoryVersions {
	const exactFamilies = exactPartitionFamilies(fn, resolution);

	// Domain partitions occupy the leading ids, so a domain's partition id is its
	// index in CORE_EFFECT_DOMAINS and a set effect bit converts to an id directly.
	const partitionIds = new Map<CoreMemoryPartition, number>(
		CORE_EFFECT_DOMAINS.map((domain, index) => [
			coreMemoryDomainPartition(domain),
			index,
		]),
	);
	const partitionFamilies = new Array<CoreMemoryFamily | undefined>(
		CORE_EFFECT_DOMAINS.length,
	).fill(undefined);
	const internExact = (location: CoreExactMemoryLocation): number => {
		const partition = coreMemoryPartition(location);
		let id = partitionIds.get(partition);
		if (id === undefined) {
			id = partitionIds.size;
			partitionIds.set(partition, id);
			partitionFamilies.push(location.kind);
		}
		return id;
	};

	const instructionIndices = new Map<CoreInstructionId, number>();
	const blockInstructionStart = new Int32Array(fn.blocks.length + 1);
	const readIds = new PackedLists();
	const exactReadIds = new PackedLists();
	const killSources = new PackedLists();
	const initializedIds = new PackedLists();
	const notifiedMasks: Array<number> = [];
	const wholeMasks: Array<number> = [];
	const universalEffects: Array<boolean> = [];
	let instructionCount = 0;
	for (let blockId = 0; blockId < fn.blocks.length; blockId += 1) {
		blockInstructionStart[blockId] = instructionCount;
		for (const instruction of fn.blocks[blockId]!.instructions) {
			instructionIndices.set(instruction.id, instructionCount);
			instructionCount += 1;
			const effects = coreInstructionEffects(instruction);
			const masks = instructionEffectMasks(effects);
			let coveredReads = 0;
			let coveredWrites = 0;
			let readDomains = 0;
			let notified = 0;
			let whole = 0;
			for (const access of effectiveAccesses(instruction)) {
				const familyMask = FAMILY_DOMAIN_MASK[access.family];
				const location = exactFamilies.has(access.family)
					? exactLocation(access, instruction, resolution)
					: undefined;
				if (access.mode === "read") {
					coveredReads |= familyMask;
					if (location === undefined) {
						readDomains |= familyMask;
						continue;
					}
					const id = internExact(location);
					readIds.push(id);
					exactReadIds.push(id);
					continue;
				}
				coveredWrites |= familyMask;
				if (location === undefined) {
					whole |= familyMask;
					continue;
				}
				killSources.push(internExact(location));
				notified |= familyMask;
			}
			// A declared domain with no surviving access — `host`, or a family this
			// function collapsed — invalidates or observes everything the domain covers.
			readDomains |= masks.reads & ~coveredReads;
			whole |= masks.writes & ~coveredWrites;
			for (let mask = readDomains; mask !== 0; ) {
				const bit = mask & -mask;
				readIds.push(lowestSetBitIndex(bit));
				mask ^= bit;
			}
			notifiedMasks.push(notified);
			wholeMasks.push(whole);
			universalEffects.push(effects.callsUserCode || effects.maySuspend);
			collectInitializedPartitions(instruction, resolution, internExact, initializedIds);
			readIds.seal();
			exactReadIds.seal();
			killSources.seal();
			initializedIds.seal();
		}
	}
	blockInstructionStart[fn.blocks.length] = instructionCount;

	// Only a partition some instruction reads can carry a value between two points,
	// so only those get a state slot.
	const slotOf = new Int32Array(partitionIds.size).fill(-1);
	let slots = 0;
	for (const id of readIds.allIds) {
		if (slotOf[id] === -1) {
			slotOf[id] = slots;
			slots += 1;
		}
	}
	if (slots === 0) return NO_MEMORY_VERSIONS;
	const maximumOwner = Math.max(instructionCount - 1, fn.blocks.length - 1, 0);
	const maximumVersion =
		(maximumOwner * VERSION_KINDS + VERSION_UNREACHABLE) * slots + (slots - 1);
	if (!Number.isSafeInteger(maximumVersion)) {
		throw new RangeError(
			`Core memory-version encoding exceeds Number.MAX_SAFE_INTEGER (${instructionCount} instructions, ${fn.blocks.length} blocks, ${slots} partitions)`,
		);
	}

	const readSlots = readIds.toSlots(slotOf, true);
	const exactReadSlots = exactReadIds.toSlots(slotOf);
	const initializedSlots = initializedIds.toSlots(slotOf);
	const exactWriteSlots = killSources.toSlots(slotOf);

	// Slots of an allocation this activation never handed out. Only the exact
	// accesses this function performs on them can change their contents, so an
	// effect the model cannot attribute to a base leaves them alone. This is the
	// resolution contract above, and it is the difference between a coercion or a
	// call being a barrier for one slot and being a barrier for all memory.
	const slotFamilies = new Array<CoreMemoryFamily | undefined>(slots).fill(undefined);
	for (const [id, slot] of slotOf.entries()) {
		if (slot >= 0) slotFamilies[slot] = partitionFamilies[id];
	}
	const unattributable: Array<number> = [];
	for (let slot = 0; slot < slots; slot += 1) {
		const family = slotFamilies[slot];
		if (family === undefined || !CONTAINED_MEMORY_FAMILIES.has(family)) {
			unattributable.push(slot);
		}
	}
	const domainSlots = new Int32Array(CORE_EFFECT_DOMAINS.length);
	for (let domain = 0; domain < CORE_EFFECT_DOMAINS.length; domain += 1) {
		domainSlots[domain] = slotOf[domain]!;
	}
	// Exact cells a whole-domain write invalidates. Contained allocations are
	// absent by construction: no unattributed effect reaches them.
	const domainExactSlots = CORE_EFFECT_DOMAINS.map((): Array<number> => []);
	for (let slot = 0; slot < slots; slot += 1) {
		const family = slotFamilies[slot];
		if (family === undefined || CONTAINED_MEMORY_FAMILIES.has(family)) continue;
		for (let mask = FAMILY_DOMAIN_MASK[family]; mask !== 0; ) {
			const bit = mask & -mask;
			domainExactSlots[lowestSetBitIndex(bit)]!.push(slot);
			mask ^= bit;
		}
	}

	// Slots each instruction invalidates. Invalidation sets repeat heavily — every
	// universal instruction that names no exact write kills the same unattributable
	// slots — so instructions share an interned set and the table stays proportional
	// to the distinct effect signatures rather than to the instruction count.
	const killLists = new Int32Array(instructionCount);
	const listOffsets: Array<number> = [0];
	const listed: Array<number> = [];
	const sharedLists = new Map<number, number>();
	const marked = new Uint8Array(slots);
	let listStart = 0;
	const kill = (slot: number): void => {
		if (slot < 0 || marked[slot] === 1) return;
		marked[slot] = 1;
		listed.push(slot);
	};
	for (let index = 0; index < instructionCount; index += 1) {
		const exactStart = exactWriteSlots.offsets[index]!;
		const exactEnd = exactWriteSlots.offsets[index + 1]!;
		// Masks occupy nine bits each, so a shared signature never reaches the
		// universal marker.
		const signature =
			universalEffects[index] === true
				? -1
				: notifiedMasks[index]! | (wholeMasks[index]! << CORE_EFFECT_DOMAINS.length);
		if (exactStart === exactEnd) {
			const shared = sharedLists.get(signature);
			if (shared !== undefined) {
				killLists[index] = shared;
				continue;
			}
		}
		listStart = listed.length;
		if (universalEffects[index] === true) {
			// A universal effect cannot reach another instruction's contained
			// allocation, but it must still perform its own resolved writes. This
			// distinction matters for an access carrying a pre-existing refinement:
			// it may remain conservatively universal while still naming the exact
			// private slot it updates.
			for (const slot of unattributable) kill(slot);
		} else {
			for (let mask = notifiedMasks[index]! | wholeMasks[index]!; mask !== 0; ) {
				const bit = mask & -mask;
				kill(domainSlots[lowestSetBitIndex(bit)]!);
				mask ^= bit;
			}
			for (let mask = wholeMasks[index]!; mask !== 0; ) {
				const bit = mask & -mask;
				for (const slot of domainExactSlots[lowestSetBitIndex(bit)]!) kill(slot);
				mask ^= bit;
			}
		}
		for (let entry = exactStart; entry < exactEnd; entry += 1) {
			kill(exactWriteSlots.slots[entry]!);
		}
		for (let entry = listStart; entry < listed.length; entry += 1)
			marked[listed[entry]!] = 0;
		const list = listOffsets.length - 1;
		listOffsets.push(listed.length);
		killLists[index] = list;
		if (exactStart === exactEnd) sharedLists.set(signature, list);
	}
	const killOffsets = Int32Array.from(listOffsets);
	const killSlots = Int32Array.from(listed);

	// One block transfer, with only the last write to each slot retained: the
	// solver never observes a state between two instructions of the same block.
	const blockKillOffsets = new Int32Array(fn.blocks.length + 1);
	const blockKilled: Array<number> = [];
	const blockVersions: Array<number> = [];
	const lastVersion = new Float64Array(slots);
	for (let blockId = 0; blockId < fn.blocks.length; blockId += 1) {
		const start = blockKilled.length;
		// Walking backwards makes the first writer reached the last one in program
		// order, and lets a block stop as soon as its suffix covers every slot.
		for (
			let index = blockInstructionStart[blockId + 1]! - 1;
			index >= blockInstructionStart[blockId]! && blockKilled.length - start < slots;
			index -= 1
		) {
			const list = killLists[index]!;
			const writeBase = (index * VERSION_KINDS + VERSION_WRITE) * slots;
			for (let entry = killOffsets[list]!; entry < killOffsets[list + 1]!; entry += 1) {
				const slot = killSlots[entry]!;
				if (marked[slot] === 1) continue;
				marked[slot] = 1;
				blockKilled.push(slot);
				lastVersion[slot] = writeBase + slot;
			}
		}
		for (let entry = start; entry < blockKilled.length; entry += 1) {
			const slot = blockKilled[entry]!;
			marked[slot] = 0;
			blockVersions.push(lastVersion[slot]!);
		}
		blockKillOffsets[blockId + 1] = blockKilled.length;
	}
	const blockKillSlots = Int32Array.from(blockKilled);
	const blockKillVersions = Float64Array.from(blockVersions);

	const entryStates = new Array<Float64Array | undefined>(fn.blocks.length);
	const exitStates = new Array<Float64Array | undefined>(fn.blocks.length);
	const merged = new Float64Array(slots);
	const outgoing = new Float64Array(slots);
	const dirty = new Uint8Array(fn.blocks.length);
	let dirtyCount = 0;
	for (const blockId of cfg.reversePostorder) {
		dirty[blockId] = 1;
		dirtyCount += 1;
	}
	const solved = Uint8Array.from(dirty);
	while (dirtyCount > 0) {
		for (const blockId of cfg.reversePostorder) {
			if (dirty[blockId] === 0) continue;
			dirty[blockId] = 0;
			dirtyCount -= 1;
			const phiBase = (blockId * VERSION_KINDS + VERSION_PHI) * slots;
			let joined = false;
			if (blockId === fn.entry) {
				for (let slot = 0; slot < slots; slot += 1) merged[slot] = VERSION_ENTRY + slot;
				joined = true;
			}
			for (const predecessor of cfg.predecessors[blockId]!) {
				const exit = exitStates[predecessor.from];
				if (exit === undefined) continue;
				if (predecessor.kind === "ordinary") {
					if (!joined) {
						merged.set(exit);
						joined = true;
						continue;
					}
					for (let slot = 0; slot < slots; slot += 1) {
						const phi = phiBase + slot;
						const current = merged[slot]!;
						if (current !== phi && current !== exit[slot]) merged[slot] = phi;
					}
					continue;
				}
				// Core's exceptional edge is block-wide: any throwing instruction can
				// transfer control after a different prefix of that block's writes.
				// Give the edge one stable opaque version instead of pretending the
				// ordinary exit ran.
				const exceptionBase =
					(predecessor.from * VERSION_KINDS + VERSION_EXCEPTION) * slots;
				if (!joined) {
					for (let slot = 0; slot < slots; slot += 1) merged[slot] = exceptionBase + slot;
					joined = true;
					continue;
				}
				for (let slot = 0; slot < slots; slot += 1) {
					const phi = phiBase + slot;
					const current = merged[slot]!;
					if (current !== phi && current !== exceptionBase + slot) merged[slot] = phi;
				}
			}
			if (!joined) continue;
			const previousEntry = entryStates[blockId];
			if (previousEntry === undefined) entryStates[blockId] = merged.slice();
			else previousEntry.set(merged);
			outgoing.set(merged);
			for (
				let entry = blockKillOffsets[blockId]!;
				entry < blockKillOffsets[blockId + 1]!;
				entry += 1
			) {
				outgoing[blockKillSlots[entry]!] = blockKillVersions[entry]!;
			}
			const previousExit = exitStates[blockId];
			if (previousExit === undefined) exitStates[blockId] = outgoing.slice();
			else if (sameState(previousExit, outgoing)) continue;
			else previousExit.set(outgoing);
			for (const successor of cfg.successors[blockId]!) {
				if (solved[successor.to] === 1 && dirty[successor.to] === 0) {
					dirty[successor.to] = 1;
					dirtyCount += 1;
				}
			}
		}
	}

	const readKeys = new Array<string | undefined>(instructionCount).fill(undefined);
	const exactReadVersions = new Float64Array(exactReadSlots.slots.length);
	const initializationVersions = new Float64Array(initializedSlots.slots.length);
	const state = new Float64Array(slots);
	for (let blockId = 0; blockId < fn.blocks.length; blockId += 1) {
		const entryState = entryStates[blockId];
		if (entryState === undefined) {
			const base = (blockId * VERSION_KINDS + VERSION_UNREACHABLE) * slots;
			for (let slot = 0; slot < slots; slot += 1) state[slot] = base + slot;
		} else {
			state.set(entryState);
		}
		for (
			let index = blockInstructionStart[blockId]!;
			index < blockInstructionStart[blockId + 1]!;
			index += 1
		) {
			const readStart = readSlots.offsets[index]!;
			const readEnd = readSlots.offsets[index + 1]!;
			if (readEnd > readStart) {
				let key = "";
				for (let entry = readStart; entry < readEnd; entry += 1) {
					const slot = readSlots.slots[entry]!;
					key += `${slot}=${state[slot]}|`;
				}
				readKeys[index] = key;
			}
			for (
				let entry = exactReadSlots.offsets[index]!;
				entry < exactReadSlots.offsets[index + 1]!;
				entry += 1
			) {
				exactReadVersions[entry] = state[exactReadSlots.slots[entry]!]!;
			}
			for (
				let entry = initializedSlots.offsets[index]!;
				entry < initializedSlots.offsets[index + 1]!;
				entry += 1
			) {
				initializationVersions[entry] = state[initializedSlots.slots[entry]!]!;
			}
			const list = killLists[index]!;
			const writeBase = (index * VERSION_KINDS + VERSION_WRITE) * slots;
			for (let entry = killOffsets[list]!; entry < killOffsets[list + 1]!; entry += 1) {
				const slot = killSlots[entry]!;
				state[slot] = writeBase + slot;
			}
		}
	}

	const trackedSlot = (partition: CoreMemoryPartition): number => {
		const id = partitionIds.get(partition);
		return id === undefined ? -1 : slotOf[id]!;
	};
	const versionAt = (
		packed: PackedSlots,
		versions: Float64Array,
		index: number,
		slot: number,
	): CoreMemoryVersion | undefined => {
		for (
			let entry = packed.offsets[index]!;
			entry < packed.offsets[index + 1]!;
			entry += 1
		) {
			if (packed.slots[entry] === slot) return versions[entry] as CoreMemoryVersion;
		}
		return undefined;
	};
	return {
		readKey(instruction) {
			const index = instructionIndices.get(instruction);
			return index === undefined ? undefined : readKeys[index];
		},
		readVersion(instruction, partition) {
			const index = instructionIndices.get(instruction);
			const slot = trackedSlot(partition);
			if (index === undefined || slot < 0) return undefined;
			return versionAt(exactReadSlots, exactReadVersions, index, slot);
		},
		initializationVersion(instruction, partition) {
			const index = instructionIndices.get(instruction);
			const slot = trackedSlot(partition);
			if (index === undefined || slot < 0) return undefined;
			return versionAt(initializedSlots, initializationVersions, index, slot);
		},
		writeVersion(instruction, partition) {
			const index = instructionIndices.get(instruction);
			const slot = trackedSlot(partition);
			if (index === undefined || slot < 0) return undefined;
			return ((index * VERSION_KINDS + VERSION_WRITE) * slots +
				slot) as CoreMemoryVersion;
		},
	};
}

/**
 * Partitions a fresh aggregate's own slots occupy, when the resolution proves the
 * layout. These are not writes: the cells did not exist before, so no earlier read
 * can be observing them, and modelling them as a write to the family would make
 * every allocation a barrier for unrelated property reads.
 */
function collectInitializedPartitions(
	instruction: CoreInstruction,
	resolution: CoreMemoryResolution | undefined,
	internExact: (location: CoreExactMemoryLocation) => number,
	into: PackedLists,
): void {
	const allocation = coreOpcodeRegistry.require(instruction.opcode).allocation;
	if (
		allocation === undefined ||
		allocation.kind !== "named-slots" ||
		resolution === undefined
	) {
		return;
	}
	const result = instruction.outputs[0];
	if (result === undefined) return;
	const keys = instruction.attributes[allocation.keysAttribute];
	if (!Array.isArray(keys)) return;
	for (const key of keys) {
		if (typeof key !== "number") continue;
		const resolved = resolution.ownCell(
			result,
			{ kind: "string-constant", index: key },
			"write",
		);
		if (resolved === undefined || resolved.cell.kind !== "object-slot") continue;
		into.push(
			internExact({
				kind: "object-slot",
				allocation: resolved.allocation,
				key: resolved.cell.key,
			}),
		);
	}
}
