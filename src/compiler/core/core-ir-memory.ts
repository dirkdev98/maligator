/**
 * Core's memory model: abstract locations, alias partitions, and an analysis-only
 * memory-SSA versioning of those partitions.
 *
 * Locations come from the opcode registry's declared accesses, never from a
 * per-pass opcode switch. Activation and program slots are named exactly, so a
 * write to one slot leaves every other slot's version alone. Heap families are
 * still named as a whole, because proving two bases distinct needs an alias
 * oracle Core does not have yet; naming them keeps their invalidation flowing
 * through the shared effect domains rather than through a pass's memory.
 *
 * Two things deliberately absent: strings, whose values are immutable so there is
 * no string cell to alias, and epochs, whose validity belongs to the fact system.
 */

import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import { coreInstructionEffects, coreOpcodeRegistry } from "./core-ir-opcodes.ts";
import { CORE_MEMORY_FAMILIES, CORE_MEMORY_FAMILY_DOMAINS } from "./core-ir.ts";
import type {
	CoreAccessMode,
	CoreBlockId,
	CoreEffectDomain,
	CoreFunction,
	CoreInstruction,
	CoreInstructionId,
	CoreMemoryFamily,
	CoreOpcodeAccess,
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
	| { readonly kind: "family"; readonly family: CoreMemoryFamily };

export type CoreExactMemoryLocation = Exclude<
	CoreMemoryLocation,
	{ readonly kind: "family" }
>;

/** Interned alias partition. Equality is the only operation callers need. */
export type CoreMemoryPartition = string & {
	readonly __coreMemoryPartition: unique symbol;
};

/** Analysis-only memory-SSA version identity of one partition at one point. */
export type CoreMemoryVersion = string & {
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
	}
}

/** Partition standing for every cell an effect domain covers. */
export function coreMemoryDomainPartition(domain: CoreEffectDomain): CoreMemoryPartition {
	return `domain\0${domain}` as CoreMemoryPartition;
}

export interface CoreMemoryAccess {
	readonly mode: CoreAccessMode;
	readonly location: CoreMemoryLocation;
	/** Declared heap base, for the future alias oracle. Not used for aliasing yet. */
	readonly base?: CoreValueId;
	readonly key?: number;
	/** Value a write stores; the forwarding source for a later read. */
	readonly value?: CoreValueId;
	/** Value a read produces; the redundancy target. */
	readonly result?: CoreValueId;
}

function integerAttribute(
	instruction: CoreInstruction,
	name: string,
): number | undefined {
	const value = instruction.attributes[name];
	return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

/**
 * Resolve an access to an exact cell, or to nothing when the instruction does not
 * carry the attributes the descriptor promised. A malformed attribute degrades to
 * the whole family, never to a narrower guess.
 */
function exactLocation(
	access: CoreOpcodeAccess,
	instruction: CoreInstruction,
): CoreExactMemoryLocation | undefined {
	const attributes = access.attributes ?? [];
	switch (access.family) {
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

/**
 * Memory one instruction touches, in declaration order. An access whose effect
 * domains a verified refinement removed is dropped, so a refinement narrows the
 * location model in exactly the same step as it narrows the effect summary.
 */
export function coreMemoryAccesses(
	instruction: CoreInstruction,
): ReadonlyArray<CoreMemoryAccess> {
	const declared = coreOpcodeRegistry.require(instruction.opcode).accesses;
	if (declared === undefined || declared.length === 0) return [];
	const effects = coreInstructionEffects(instruction);
	const accesses: Array<CoreMemoryAccess> = [];
	for (const access of declared) {
		const domains = CORE_MEMORY_FAMILY_DOMAINS[access.family];
		const effective = access.mode === "read" ? effects.reads : effects.writes;
		if (!domains.some((domain) => effective.includes(domain))) continue;
		const base =
			access.baseOperand === undefined
				? undefined
				: instruction.inputs[access.baseOperand];
		const value =
			access.valueOperand === undefined
				? undefined
				: instruction.inputs[access.valueOperand];
		const key =
			access.keyAttribute === undefined
				? undefined
				: integerAttribute(instruction, access.keyAttribute);
		accesses.push({
			mode: access.mode,
			location:
				exactLocation(access, instruction) ??
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
 * More exact cells than this in one family stop earning their precision, so the
 * family collapses to its domain partitions. The bound keeps the per-instruction
 * invalidation set, and therefore the whole analysis, linear in the instruction
 * count for any function.
 */
const MAX_EXACT_PARTITIONS_PER_FAMILY = 64;

interface InstructionMemoryFacts {
	readonly reads: ReadonlyArray<CoreMemoryPartition>;
	readonly exactReads: ReadonlyArray<CoreMemoryPartition>;
	readonly exactWrites: ReadonlyArray<CoreMemoryPartition>;
	/** Domains an exact write must announce to whole-family readers. */
	readonly notifiedDomains: ReadonlyArray<CoreEffectDomain>;
	/** Domains written in full, which also invalidate every exact cell in them. */
	readonly wholeDomains: ReadonlyArray<CoreEffectDomain>;
	readonly universal: boolean;
}

function instructionMemoryFacts(
	instruction: CoreInstruction,
	exactFamilies: ReadonlySet<CoreMemoryFamily>,
	familyOfPartition: Map<CoreMemoryPartition, CoreMemoryFamily>,
): InstructionMemoryFacts {
	const effects = coreInstructionEffects(instruction);
	const reads = new Set<CoreMemoryPartition>();
	const exactReads = new Set<CoreMemoryPartition>();
	const exactWrites = new Set<CoreMemoryPartition>();
	const notifiedDomains = new Set<CoreEffectDomain>();
	const wholeDomains = new Set<CoreEffectDomain>();
	const covered = {
		read: new Set<CoreEffectDomain>(),
		write: new Set<CoreEffectDomain>(),
	};
	for (const access of coreMemoryAccesses(instruction)) {
		const location = access.location;
		const family = coreMemoryLocationFamily(location);
		const domains = CORE_MEMORY_FAMILY_DOMAINS[family];
		for (const domain of domains) covered[access.mode].add(domain);
		const partition =
			coreMemoryLocationIsExact(location) && exactFamilies.has(family)
				? coreMemoryPartition(location)
				: undefined;
		if (partition !== undefined) familyOfPartition.set(partition, family);
		if (access.mode === "read") {
			if (partition === undefined) {
				for (const domain of domains) reads.add(coreMemoryDomainPartition(domain));
			} else {
				reads.add(partition);
				exactReads.add(partition);
			}
			continue;
		}
		if (partition === undefined) {
			for (const domain of domains) wholeDomains.add(domain);
		} else {
			exactWrites.add(partition);
			for (const domain of domains) notifiedDomains.add(domain);
		}
	}
	// A declared domain with no surviving access — `host`, or a family this
	// function collapsed — invalidates or observes everything the domain covers.
	for (const domain of effects.reads) {
		if (!covered.read.has(domain)) reads.add(coreMemoryDomainPartition(domain));
	}
	for (const domain of effects.writes) {
		if (!covered.write.has(domain)) wholeDomains.add(domain);
	}
	return {
		reads: [...reads],
		exactReads: [...exactReads],
		exactWrites: [...exactWrites],
		notifiedDomains: [...notifiedDomains],
		wholeDomains: [...wholeDomains],
		universal: effects.callsUserCode || effects.maySuspend,
	};
}

function exactPartitionFamilies(fn: CoreFunction): ReadonlySet<CoreMemoryFamily> {
	const counts = new Map<CoreMemoryFamily, Set<CoreMemoryPartition>>();
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			for (const access of coreMemoryAccesses(instruction)) {
				if (!coreMemoryLocationIsExact(access.location)) continue;
				const family = coreMemoryLocationFamily(access.location);
				const partitions = counts.get(family) ?? new Set<CoreMemoryPartition>();
				partitions.add(coreMemoryPartition(access.location));
				counts.set(family, partitions);
			}
		}
	}
	return new Set(
		CORE_MEMORY_FAMILIES.filter(
			(family) => (counts.get(family)?.size ?? 0) <= MAX_EXACT_PARTITIONS_PER_FAMILY,
		),
	);
}

function entryVersion(partition: CoreMemoryPartition): CoreMemoryVersion {
	return `entry\0${partition}` as CoreMemoryVersion;
}

function writeVersion(
	instruction: CoreInstructionId,
	partition: CoreMemoryPartition,
): CoreMemoryVersion {
	return `write\0${instruction}\0${partition}` as CoreMemoryVersion;
}

function phiVersion(
	block: CoreBlockId,
	partition: CoreMemoryPartition,
): CoreMemoryVersion {
	return `phi\0${block}\0${partition}` as CoreMemoryVersion;
}

function exceptionVersion(
	block: CoreBlockId,
	partition: CoreMemoryPartition,
): CoreMemoryVersion {
	return `exception\0${block}\0${partition}` as CoreMemoryVersion;
}

function unreachableVersion(
	block: CoreBlockId,
	partition: CoreMemoryPartition,
): CoreMemoryVersion {
	return `unreachable\0${block}\0${partition}` as CoreMemoryVersion;
}

export interface CoreInstructionMemoryVersions {
	/** Value-numbering key over every partition the instruction reads. */
	readonly key: string;
	/** Version of each exactly named partition read, for store-to-load forwarding. */
	readonly exact: ReadonlyMap<CoreMemoryPartition, CoreMemoryVersion>;
}

export interface CoreMemoryVersions {
	readonly reads: ReadonlyMap<CoreInstructionId, CoreInstructionMemoryVersions>;
	/** Version an instruction's exact write installs, for a following reader. */
	writeVersion(
		instruction: CoreInstructionId,
		partition: CoreMemoryPartition,
	): CoreMemoryVersion;
	/** Partitions this instruction writes exactly and can forward a value from. */
	exactWrites(instruction: CoreInstructionId): ReadonlyArray<CoreMemoryPartition>;
}

type MemoryState = ReadonlyMap<CoreMemoryPartition, CoreMemoryVersion>;

function sameState(
	left: MemoryState | undefined,
	right: MemoryState,
	partitions: ReadonlyArray<CoreMemoryPartition>,
): boolean {
	return (
		left !== undefined &&
		partitions.every((partition) => left.get(partition) === right.get(partition))
	);
}

/**
 * Version every partition read anywhere in the function.
 *
 * Each (block, partition) entry version is a point in a height-three lattice:
 * unset, one concrete version, or this block's own memory phi. Joining two
 * different concrete versions yields the phi, and a phi never becomes concrete
 * again, so the transfer functions are monotone and the fixed point is reached in
 * at most two updates per (block, partition) — O(blocks * partitions) updates and
 * O(edges * partitions) work overall.
 *
 * Retaining the phi's *identity* is what makes a version usable as a
 * value-equality proof. A set of reaching writes is not: two points in a loop can
 * see the same set of writes while observing different ones on a single concrete
 * iteration.
 */
export function coreMemoryVersions(
	fn: CoreFunction,
	cfg: CoreControlFlow,
): CoreMemoryVersions {
	const exactFamilies = exactPartitionFamilies(fn);
	const facts = new Map<CoreInstructionId, InstructionMemoryFacts>();
	const familyOfPartition = new Map<CoreMemoryPartition, CoreMemoryFamily>();
	const tracked = new Set<CoreMemoryPartition>();
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			const instructionFacts = instructionMemoryFacts(
				instruction,
				exactFamilies,
				familyOfPartition,
			);
			facts.set(instruction.id, instructionFacts);
			for (const partition of instructionFacts.reads) tracked.add(partition);
		}
	}
	const reads = new Map<CoreInstructionId, CoreInstructionMemoryVersions>();
	const exactWrites = new Map<CoreInstructionId, ReadonlyArray<CoreMemoryPartition>>();
	for (const [instruction, instructionFacts] of facts) {
		const forwardable = instructionFacts.exactWrites.filter((partition) =>
			tracked.has(partition),
		);
		if (forwardable.length > 0) exactWrites.set(instruction, forwardable);
	}
	const versions: CoreMemoryVersions = {
		reads,
		writeVersion,
		exactWrites: (instruction) => exactWrites.get(instruction) ?? [],
	};
	if (tracked.size === 0) return versions;

	const partitions = [...tracked];
	const exactPartitionsForDomain = new Map<
		CoreEffectDomain,
		Array<CoreMemoryPartition>
	>();
	for (const partition of partitions) {
		const family = familyOfPartition.get(partition);
		if (family === undefined) continue;
		for (const domain of CORE_MEMORY_FAMILY_DOMAINS[family]) {
			const existing = exactPartitionsForDomain.get(domain) ?? [];
			existing.push(partition);
			exactPartitionsForDomain.set(domain, existing);
		}
	}

	/** Partitions one instruction invalidates, computed once per instruction. */
	const invalidated = new Map<CoreInstructionId, ReadonlyArray<CoreMemoryPartition>>();
	const invalidatedBy = (
		instruction: CoreInstructionId,
	): ReadonlyArray<CoreMemoryPartition> => {
		const cached = invalidated.get(instruction);
		if (cached !== undefined) return cached;
		const instructionFacts = facts.get(instruction)!;
		let result: Array<CoreMemoryPartition>;
		if (instructionFacts.universal) {
			result = partitions;
		} else {
			const killed = new Set<CoreMemoryPartition>();
			for (const partition of instructionFacts.exactWrites) {
				if (tracked.has(partition)) killed.add(partition);
			}
			for (const domain of [
				...instructionFacts.notifiedDomains,
				...instructionFacts.wholeDomains,
			]) {
				const partition = coreMemoryDomainPartition(domain);
				if (tracked.has(partition)) killed.add(partition);
			}
			for (const domain of instructionFacts.wholeDomains) {
				for (const partition of exactPartitionsForDomain.get(domain) ?? []) {
					killed.add(partition);
				}
			}
			result = [...killed];
		}
		invalidated.set(instruction, result);
		return result;
	};

	const entry = new Map<CoreMemoryPartition, CoreMemoryVersion>(
		partitions.map((partition) => [partition, entryVersion(partition)]),
	);
	const entries = new Array<MemoryState | undefined>(fn.blocks.length);
	const exits = new Array<MemoryState | undefined>(fn.blocks.length);
	let progress = true;
	while (progress) {
		progress = false;
		for (const blockId of cfg.reversePostorder) {
			const block = fn.blocks[blockId]!;
			const incoming: Array<MemoryState> = [];
			if (block.id === fn.entry) incoming.push(entry);
			for (const predecessor of cfg.predecessors[block.id]!) {
				const state = exits[predecessor.from];
				if (state === undefined) continue;
				if (predecessor.kind === "ordinary") {
					incoming.push(state);
					continue;
				}
				// Core's exceptional edge is block-wide: any throwing instruction can
				// transfer control after a different prefix of that block's writes.
				// Give the edge one stable opaque version instead of pretending the
				// ordinary exit ran.
				incoming.push(
					new Map(
						partitions.map((partition) => [
							partition,
							exceptionVersion(predecessor.from, partition),
						]),
					),
				);
			}
			if (incoming.length === 0) continue;
			const merged = new Map<CoreMemoryPartition, CoreMemoryVersion>();
			for (const partition of partitions) {
				const first = incoming[0]!.get(partition)!;
				merged.set(
					partition,
					incoming.every((state) => state.get(partition) === first)
						? first
						: phiVersion(block.id, partition),
				);
			}
			if (!sameState(entries[block.id], merged, partitions)) {
				entries[block.id] = merged;
				progress = true;
			}
			const outgoing = new Map(merged);
			for (const instruction of block.instructions) {
				for (const partition of invalidatedBy(instruction.id)) {
					outgoing.set(partition, writeVersion(instruction.id, partition));
				}
			}
			if (!sameState(exits[block.id], outgoing, partitions)) {
				exits[block.id] = outgoing;
				progress = true;
			}
		}
	}

	for (const block of fn.blocks) {
		const state = new Map<CoreMemoryPartition, CoreMemoryVersion>(
			entries[block.id] ??
				partitions.map((partition) => [
					partition,
					unreachableVersion(block.id, partition),
				]),
		);
		for (const instruction of block.instructions) {
			const instructionFacts = facts.get(instruction.id)!;
			if (instructionFacts.reads.length > 0) {
				const exact = new Map<CoreMemoryPartition, CoreMemoryVersion>();
				for (const partition of instructionFacts.exactReads) {
					const version = state.get(partition);
					if (version !== undefined) exact.set(partition, version);
				}
				reads.set(instruction.id, {
					key: [...instructionFacts.reads]
						.sort()
						.map((partition) => `${partition}=${state.get(partition)}`)
						.join("|"),
					exact,
				});
			}
			for (const partition of invalidatedBy(instruction.id)) {
				state.set(partition, writeVersion(instruction.id, partition));
			}
		}
	}
	return versions;
}
