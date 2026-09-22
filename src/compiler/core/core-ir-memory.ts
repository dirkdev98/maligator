import type { CoreAnalysisDefinition } from "./core-analysis-manager.ts";
import {
	CORE_CONTROL_FLOW_BUNDLE_ANALYSIS,
	buildCoreControlFlow,
	coreCanonicalValueRoots,
} from "./core-ir-control-flow.ts";
import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import { coreInstructionEffects } from "./core-ir-opcodes.ts";
import {
	CORE_LOCAL_FACT_BUNDLE_ANALYSIS,
	buildCoreProvenance,
} from "./core-ir-provenance.ts";
import type { CoreAccessKey, CoreOwnCell, CoreProvenance } from "./core-ir-provenance.ts";
import {
	CORE_EFFECT_DOMAINS,
	CORE_MEMORY_FAMILIES,
	CORE_MEMORY_FAMILY_DOMAINS,
} from "./core-ir.ts";
import type {
	CoreAccessMode,
	CoreBlockId,
	CoreEffectDomain,
	CoreFunctionId,
	CoreInstructionId,
	CoreMemoryFamily,
	CoreOpcodeAccess,
	CoreValueId,
} from "./core-ir.ts";
import { CORE_OPTIMIZATION_OWNER } from "./core-optimization-owners.ts";
import type { CoreOptimizationOwnerRunner } from "./core-optimization-owners.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

export type CoreMemoryLocation =
	| { readonly kind: "global-slot"; readonly slot: number }
	| { readonly kind: "local-slot"; readonly slot: number }
	| {
			readonly kind: "captured-slot";
			readonly owner: number;
			readonly index: number;
	  }
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

export type CoreMemoryLocationId = number & {
	readonly __coreMemoryLocationId: unique symbol;
};

export function coreMemoryLocationFamily(location: CoreMemoryLocation): CoreMemoryFamily {
	return location.kind === "family" ? location.family : location.kind;
}

export function coreMemoryLocationIsExact(
	location: CoreMemoryLocation,
): location is CoreExactMemoryLocation {
	return location.kind !== "family";
}

export class CoreMemoryLocationTable {
	#next: number;
	#activationThis: CoreMemoryLocationId | undefined;
	readonly #globalSlots = new Map<number, CoreMemoryLocationId>();
	readonly #localSlots = new Map<number, CoreMemoryLocationId>();
	readonly #capturedSlots = new Map<number, Map<number, CoreMemoryLocationId>>();
	readonly #objectSlots = new Map<number, Map<number, CoreMemoryLocationId>>();
	readonly #elements = new Map<number, Map<number, CoreMemoryLocationId>>();

	constructor(firstId = 0) {
		this.#next = firstId;
	}

	get size(): number {
		return this.#next;
	}

	#allocate(): CoreMemoryLocationId {
		const allocated = this.#next as CoreMemoryLocationId;
		this.#next++;
		return allocated;
	}

	#single(entries: Map<number, CoreMemoryLocationId>, key: number): CoreMemoryLocationId {
		const existing = entries.get(key);
		if (existing !== undefined) return existing;
		const created = this.#allocate();
		entries.set(key, created);
		return created;
	}

	#pair(
		entries: Map<number, Map<number, CoreMemoryLocationId>>,
		first: number,
		second: number,
	): CoreMemoryLocationId {
		const nested = entries.get(first) ?? new Map<number, CoreMemoryLocationId>();
		entries.set(first, nested);
		return this.#single(nested, second);
	}

	id(location: CoreExactMemoryLocation): CoreMemoryLocationId {
		switch (location.kind) {
			case "global-slot":
				return this.#single(this.#globalSlots, location.slot);
			case "local-slot":
				return this.#single(this.#localSlots, location.slot);
			case "captured-slot":
				return this.#pair(this.#capturedSlots, location.owner, location.index);
			case "activation-this":
				return (this.#activationThis ??= this.#allocate());
			case "object-slot":
				return this.#pair(this.#objectSlots, location.allocation, location.key);
			case "element":
				return this.#pair(this.#elements, location.allocation, location.index);
		}
	}
}

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
	readonly base?: CoreValueId;
	readonly key?: CoreAccessKey;
	readonly value?: CoreValueId;
	readonly result?: CoreValueId;
}

function integerAttribute(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	name: string,
): number | undefined {
	const value = fn.instructionAttributes(instruction)[name];
	return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function operandAt(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	operand: number,
): CoreValueId | undefined {
	return operand < fn.kernel.instructionOperandCount(instruction)
		? fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction) + operand)
		: undefined;
}

function declaredKey(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	access: CoreOpcodeAccess,
): CoreAccessKey | undefined {
	if (access.keyAttribute !== undefined) {
		const index = integerAttribute(fn, instruction, access.keyAttribute);
		return index === undefined ? undefined : { kind: "string-constant", index };
	}
	if (access.keyOperand !== undefined) {
		const value = operandAt(fn, instruction, access.keyOperand);
		return value === undefined ? undefined : { kind: "operand", value };
	}
	return undefined;
}

function accessIsEffective(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	access: CoreOpcodeAccess,
): boolean {
	const effects = coreInstructionEffects(fn, instruction);
	const domains = access.mode === "read" ? effects.reads : effects.writes;
	return CORE_MEMORY_FAMILY_DOMAINS[access.family].some((domain) =>
		domains.includes(domain),
	);
}

function exactLocation(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	access: CoreOpcodeAccess,
	resolution: CoreMemoryResolution | undefined,
	base: CoreValueId | undefined,
	key: CoreAccessKey | undefined,
): CoreExactMemoryLocation | undefined {
	const attributes = access.attributes ?? [];
	switch (access.family) {
		case "object-slot": {
			if (resolution === undefined || access.baseOperand === undefined) return undefined;
			if (base === undefined || key === undefined) return undefined;
			const resolved = resolution.ownCell(base, key, access.mode);
			if (resolved === undefined) return undefined;
			return resolved.cell.kind === "element"
				? { kind: "element", allocation: resolved.allocation, index: resolved.cell.index }
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
					? integerAttribute(fn, instruction, attributes[0]!)
					: undefined;
			return slot === undefined ? undefined : { kind: access.family, slot };
		}
		case "captured-slot": {
			if (attributes.length !== 2) return undefined;
			const owner = integerAttribute(fn, instruction, attributes[0]!);
			const index = integerAttribute(fn, instruction, attributes[1]!);
			return owner === undefined || index === undefined
				? undefined
				: { kind: "captured-slot", owner, index };
		}
		default:
			return undefined;
	}
}

export function coreMemoryAccesses(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	resolution?: CoreMemoryResolution,
): ReadonlyArray<CoreMemoryAccess> {
	if (fn.instructionKind(instruction) !== "operation") return [];
	const accesses: Array<CoreMemoryAccess> = [];
	for (const access of fn.registry.byId(fn.instructionOpcode(instruction)).accesses ??
		[]) {
		if (!accessIsEffective(fn, instruction, access)) continue;
		const base =
			access.baseOperand === undefined
				? undefined
				: operandAt(fn, instruction, access.baseOperand);
		const key = declaredKey(fn, instruction, access);
		const value =
			access.valueOperand === undefined
				? undefined
				: operandAt(fn, instruction, access.valueOperand);
		const result =
			access.mode === "read" && fn.kernel.instructionResultCount(instruction) === 1
				? fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction))
				: undefined;
		const memoryAccess: CoreMemoryAccess = {
			mode: access.mode,
			location: exactLocation(fn, instruction, access, resolution, base, key) ?? {
				kind: "family",
				family: access.family,
			},
			base,
			key,
			value,
			result,
		};
		accesses.push(Object.freeze(memoryAccess));
	}
	return Object.freeze(accesses);
}

export class CoreMemoryValueSources {
	readonly #locations = new CoreMemoryLocationTable();
	readonly #writes = new Set<CoreMemoryLocationId>();

	constructor(fn: CoreFunctionStore) {
		for (const instruction of fn.instructionIds()) {
			if (fn.instructionKind(instruction) !== "operation") continue;
			const descriptor = fn.registry.byId(fn.instructionOpcode(instruction));
			if (
				!descriptor.accesses?.some(
					(access) => access.mode === "write" && access.valueOperand !== undefined,
				)
			)
				continue;
			for (const access of coreMemoryAccesses(fn, instruction)) {
				if (
					access.mode === "write" &&
					access.value !== undefined &&
					coreMemoryLocationIsExact(access.location)
				)
					this.#writes.add(this.#locations.id(access.location));
			}
		}
	}

	maySupply(location: CoreExactMemoryLocation): boolean {
		// Heap initializers and aliases need provenance; slot values require an explicit local write.
		return (
			location.kind === "object-slot" ||
			location.kind === "element" ||
			this.#writes.has(this.#locations.id(location))
		);
	}
}

export interface CoreMemoryVersions {
	readonly function: CoreFunctionId;
	readonly statistics: {
		readonly accesses: number;
		readonly indexedInstructions: number;
		readonly heapAccessesResolved: number;
		readonly events: number;
		readonly partitions: number;
		readonly exactPartitions: number;
		readonly solvedPartitions: number;
		readonly touchedBlocks: number;
		readonly stateRows: number;
		readonly stateEntries: number;
		readonly phis: number;
		readonly transfers: number;
		readonly familyWidenings: number;
		readonly blockUpdates: number;
	};
	readHash(instruction: CoreInstructionId): number | undefined;
	readsEquivalent(left: CoreInstructionId, right: CoreInstructionId): boolean;
	valueForRead(
		instruction: CoreInstructionId,
		location: CoreExactMemoryLocation,
	): CoreValueId | undefined;
}

type MemoryPartition =
	| { readonly kind: "domain"; readonly domain: CoreEffectDomain }
	| { readonly kind: "kill"; readonly family: CoreMemoryFamily }
	| { readonly kind: "exact"; readonly location: CoreExactMemoryLocation };

const runWithoutOwner: CoreOptimizationOwnerRunner = (_owner, run) => run();

function resolutionFor(provenance: CoreProvenance): CoreMemoryResolution {
	const resolution: CoreMemoryResolution = {
		ownCell(base, key, mode) {
			const resolved = provenance.ownCell(base, key, mode);
			return resolved === undefined
				? undefined
				: { allocation: resolved.layout.instruction, cell: resolved.cell };
		},
	};
	return Object.freeze(resolution);
}

function prepareMemoryVersions(
	fn: CoreFunctionStore,
	cfg: CoreControlFlow,
	provenance: () => CoreProvenance,
	roots: () => ReadonlyMap<CoreValueId, CoreValueId>,
	runOwner: CoreOptimizationOwnerRunner,
	recordResult: ((value: unknown) => void) | undefined,
): CoreMemoryVersions {
	const statistics = {
		accesses: 0,
		indexedInstructions: 0,
		heapAccessesResolved: 0,
		events: 0,
		partitions: 0,
		exactPartitions: 0,
		solvedPartitions: 0,
		touchedBlocks: 0,
		stateRows: 0,
		stateEntries: 0,
		phis: 0,
		transfers: 0,
		familyWidenings: 0,
		blockUpdates: 0,
	};
	const addStatistics = (delta: Partial<typeof statistics>): void => {
		for (const key of Object.keys(delta) as Array<keyof typeof statistics>)
			statistics[key] += delta[key]!;
		recordResult?.({ statistics: delta });
	};
	const locationTable = new CoreMemoryLocationTable();
	const rawAccesses = new Map<CoreInstructionId, ReadonlyArray<CoreMemoryAccess>>();
	const resolvedAccesses = new Map<CoreInstructionId, ReadonlyArray<CoreMemoryAccess>>();
	const instructionOrder = new Map<CoreInstructionId, number>();
	const exactInstructions = new Map<CoreMemoryLocationId, Set<CoreInstructionId>>();
	const exactReads = new Set<CoreMemoryLocationId>();
	const familyCheckpoints = new Map<CoreMemoryFamily, Set<CoreInstructionId>>();
	const domainReaders = new Map<CoreEffectDomain, Set<CoreInstructionId>>();
	const domainWriters = new Map<CoreEffectDomain, Set<CoreInstructionId>>();
	const heapInstructions = new Set<CoreInstructionId>();
	const heapByRoot = new Map<CoreValueId, Set<CoreInstructionId>>();
	let indexed = false,
		heapIndexed = false;
	const addTo = <K>(
		map: Map<K, Set<CoreInstructionId>>,
		key: K,
		instruction: CoreInstructionId,
	): void => {
		const entries = map.get(key) ?? new Set<CoreInstructionId>();
		entries.add(instruction);
		map.set(key, entries);
	};
	const heapLocation = (location: CoreMemoryLocation): boolean =>
		location.kind === "object-slot" || location.kind === "element";
	const ensureIndex = (): void => {
		if (indexed) return;
		runOwner(CORE_OPTIMIZATION_OWNER.memoryEventExtraction, () => {
			let indexedInstructions = 0,
				accesses = 0;
			for (const block of fn.blockIds()) {
				if (!cfg.reachable.has(block)) continue;
				for (const instruction of fn.bodyInstructionIds(block)) {
					const order = indexedInstructions++;
					const descriptor = fn.registry.byId(fn.instructionOpcode(instruction));
					if (
						(descriptor.accesses?.length ?? 0) === 0 &&
						descriptor.allocation === undefined &&
						descriptor.effects.writes.length === 0 &&
						!descriptor.effects.callsUserCode &&
						!descriptor.effects.maySuspend
					)
						continue;
					instructionOrder.set(instruction, order);
					const effects = coreInstructionEffects(fn, instruction);
					const raw =
						(descriptor.accesses?.length ?? 0) === 0
							? []
							: coreMemoryAccesses(fn, instruction);
					if (raw.length > 0) rawAccesses.set(instruction, raw);
					accesses += raw.length;
					for (const access of raw) {
						const family = coreMemoryLocationFamily(access.location);
						if (family === "object-slot" && access.base !== undefined)
							heapInstructions.add(instruction);
						if (coreMemoryLocationIsExact(access.location)) {
							const id = locationTable.id(access.location);
							addTo(exactInstructions, id, instruction);
							if (access.mode === "read") exactReads.add(id);
							if (!heapLocation(access.location))
								addTo(familyCheckpoints, family, instruction);
						}
						if (access.mode === "write" || !coreMemoryLocationIsExact(access.location))
							for (const domain of CORE_MEMORY_FAMILY_DOMAINS[family])
								addTo(
									access.mode === "read" ? domainReaders : domainWriters,
									domain,
									instruction,
								);
						// An own-cell proof can refine an object-property access to an array element.
						if (access.mode === "write" && family === "object-slot")
							addTo(domainWriters, "array-element", instruction);
					}
					const domains =
						effects.callsUserCode || effects.maySuspend
							? CORE_EFFECT_DOMAINS
							: effects.writes;
					for (const domain of domains) addTo(domainWriters, domain, instruction);
				}
			}
			indexed = true;
			addStatistics({ indexedInstructions, accesses });
		});
	};
	const accessesFor = (
		instruction: CoreInstructionId,
	): ReadonlyArray<CoreMemoryAccess> => {
		ensureIndex();
		const raw = rawAccesses.get(instruction) ?? [];
		if (!heapInstructions.has(instruction)) return raw;
		const known = resolvedAccesses.get(instruction);
		if (known !== undefined) return known;
		return runOwner(CORE_OPTIMIZATION_OWNER.memoryEventExtraction, () => {
			const resolved = coreMemoryAccesses(fn, instruction, resolutionFor(provenance()));
			resolvedAccesses.set(instruction, resolved);
			addStatistics({ heapAccessesResolved: resolved.length });
			return resolved;
		});
	};
	const heapStream = (allocation: CoreInstructionId): ReadonlySet<CoreInstructionId> => {
		if (!heapIndexed) {
			const canonical = roots();
			for (const instruction of heapInstructions)
				for (const access of rawAccesses.get(instruction) ?? []) {
					if (
						access.base !== undefined &&
						coreMemoryLocationFamily(access.location) === "object-slot"
					)
						addTo(heapByRoot, canonical.get(access.base) ?? access.base, instruction);
				}
			heapIndexed = true;
		}
		const result = fn.kernel.resultAt(fn.kernel.instructionResultStart(allocation));
		return heapByRoot.get(roots().get(result) ?? result) ?? new Set();
	};
	const partitions: Array<MemoryPartition> = CORE_EFFECT_DOMAINS.map((domain) => ({
		kind: "domain",
		domain,
	}));
	const domainSlot = new Map(CORE_EFFECT_DOMAINS.map((domain, slot) => [domain, slot]));
	const killSlotByFamily = new Map<CoreMemoryFamily, number>();
	for (const family of CORE_MEMORY_FAMILIES) {
		killSlotByFamily.set(family, partitions.length);
		partitions.push({ kind: "kill", family });
	}
	const slotByLocation = new Map<CoreMemoryLocationId, number>();
	const exactSlot = (location: CoreExactMemoryLocation): number => {
		const id = locationTable.id(location),
			known = slotByLocation.get(id);
		if (known !== undefined) return known;
		const created = partitions.length;
		partitions.push({ kind: "exact", location });
		slotByLocation.set(id, created);
		return created;
	};
	let nextVersion = 1;
	const entryVersions = new Map<number, number>();
	const entryIdentity = (slot: number): number => {
		const known = entryVersions.get(slot);
		if (known !== undefined) return known;
		const created = nextVersion++;
		entryVersions.set(slot, created);
		return created;
	};
	const phiVersions = new Map<number, Map<number, number>>(),
		exceptionVersions = new Map<number, Map<number, number>>();
	const internVersion = (
		table: Map<number, Map<number, number>>,
		owner: number,
		slot: number,
	): number => {
		const entries = table.get(owner) ?? new Map<number, number>();
		table.set(owner, entries);
		const known = entries.get(slot);
		if (known !== undefined) return known;
		const created = nextVersion++;
		entries.set(slot, created);
		return created;
	};
	const phiIdentity = (block: CoreBlockId, slot: number): number =>
		internVersion(phiVersions, block, slot);
	const exceptionIdentity = (block: CoreBlockId, slot: number): number =>
		internVersion(exceptionVersions, block, slot);
	const valueByVersion = new Map<number, CoreValueId>();
	const exactWriteKillRequirements = new Map<
		number,
		{ readonly instruction: CoreInstructionId; readonly slot: number }
	>();
	const readSlotsByInstruction = new Map<CoreInstructionId, ReadonlySet<number>>();
	const slotsForRead = (
		instruction: CoreInstructionId,
	): ReadonlySet<number> | undefined => {
		const known = readSlotsByInstruction.get(instruction);
		if (known !== undefined) return known;
		const slots = new Set<number>();
		for (const access of accessesFor(instruction)) {
			const family = coreMemoryLocationFamily(access.location);
			if (access.mode === "read") {
				if (coreMemoryLocationIsExact(access.location)) {
					slots.add(exactSlot(access.location));
					if (!heapLocation(access.location)) slots.add(killSlotByFamily.get(family)!);
				} else
					for (const domain of CORE_MEMORY_FAMILY_DOMAINS[family])
						slots.add(domainSlot.get(domain)!);
			} else if (
				coreMemoryLocationIsExact(access.location) &&
				!heapLocation(access.location) &&
				exactReads.has(locationTable.id(access.location))
			)
				slots.add(killSlotByFamily.get(family)!);
		}
		if (slots.size === 0) return undefined;
		readSlotsByInstruction.set(instruction, slots);
		return slots;
	};
	interface MemoryEvent {
		readonly instruction: CoreInstructionId;
		readonly reads: boolean;
		readonly definition?: number;
	}
	const touchedBlocks = new Set<CoreBlockId>();
	const prepareColumn = (slot: number) =>
		runOwner(CORE_OPTIMIZATION_OWNER.memoryEventExtraction, () => {
			ensureIndex();
			const partition = partitions[slot]!;
			const instructions = new Set<CoreInstructionId>();
			let initial:
				| { readonly instruction: CoreInstructionId; readonly value: CoreValueId }
				| undefined;
			if (partition.kind === "exact") {
				if (heapLocation(partition.location)) {
					const location = partition.location;
					if (location.kind !== "object-slot" && location.kind !== "element")
						throw new Error("Expected heap location");
					for (const instruction of heapStream(location.allocation))
						instructions.add(instruction);
					const layout = provenance().layout(location.allocation);
					if (location.kind === "object-slot" && layout?.kind === "named-slots") {
						const value = layout.initialValues[layout.keys.indexOf(location.key)];
						if (value !== undefined) {
							initial = { instruction: location.allocation, value };
							instructions.add(location.allocation);
						}
					}
				} else
					for (const instruction of exactInstructions.get(
						locationTable.id(partition.location),
					) ?? [])
						instructions.add(instruction);
			} else if (partition.kind === "domain") {
				for (const instruction of domainReaders.get(partition.domain) ?? [])
					instructions.add(instruction);
				for (const instruction of domainWriters.get(partition.domain) ?? [])
					instructions.add(instruction);
			} else {
				for (const instruction of familyCheckpoints.get(partition.family) ?? [])
					instructions.add(instruction);
				for (const domain of CORE_MEMORY_FAMILY_DOMAINS[partition.family])
					for (const instruction of domainWriters.get(domain) ?? [])
						instructions.add(instruction);
			}
			const eventsByBlock = new Map<CoreBlockId, Array<MemoryEvent>>();
			const readers: Array<CoreInstructionId> = [];
			const readBlocks = new Set<CoreBlockId>(),
				definitions = new Set<CoreBlockId>(),
				upwardExposedReadBlocks = new Set<CoreBlockId>();
			let events = 0,
				familyWidenings = 0;
			const ordered = [...instructions].sort(
				(left, right) => instructionOrder.get(left)! - instructionOrder.get(right)!,
			);
			for (const instruction of ordered) {
				if (!instructionOrder.has(instruction)) continue;
				const raw = rawAccesses.get(instruction) ?? [];
				let reads = false,
					defines = false,
					value: CoreValueId | undefined;
				if (partition.kind === "exact") {
					const id = locationTable.id(partition.location);
					const accesses = heapLocation(partition.location)
						? accessesFor(instruction)
						: raw;
					for (const access of accesses) {
						if (
							!coreMemoryLocationIsExact(access.location) ||
							locationTable.id(access.location) !== id
						)
							continue;
						if (access.mode === "read") reads = true;
						else {
							defines = true;
							value = access.value;
						}
					}
					if (initial?.instruction === instruction) {
						defines = true;
						value = initial.value;
					}
				} else {
					const effects = coreInstructionEffects(fn, instruction);
					if (partition.kind === "domain") {
						reads = domainReaders.get(partition.domain)?.has(instruction) ?? false;
						const accesses =
							partition.domain === "array-element" ? accessesFor(instruction) : raw;
						defines =
							effects.callsUserCode ||
							effects.maySuspend ||
							effects.writes.includes(partition.domain) ||
							accesses.some(
								(access) =>
									access.mode === "write" &&
									CORE_MEMORY_FAMILY_DOMAINS[
										coreMemoryLocationFamily(access.location)
									].includes(partition.domain),
							);
					} else {
						// Later queries need the kill version at their reaching stores too.
						reads = raw.some(
							(access) =>
								coreMemoryLocationIsExact(access.location) &&
								coreMemoryLocationFamily(access.location) === partition.family &&
								exactReads.has(locationTable.id(access.location)),
						);
						for (const domain of CORE_MEMORY_FAMILY_DOMAINS[partition.family]) {
							let covered = false;
							for (const access of raw) {
								if (
									access.mode !== "write" ||
									!CORE_MEMORY_FAMILY_DOMAINS[
										coreMemoryLocationFamily(access.location)
									].includes(domain)
								)
									continue;
								covered = true;
								if (!coreMemoryLocationIsExact(access.location)) defines = true;
							}
							if (
								effects.callsUserCode ||
								effects.maySuspend ||
								(!covered && effects.writes.includes(domain))
							)
								defines = true;
						}
						if (defines) familyWidenings++;
					}
				}
				if (!reads && !defines) continue;
				const block = fn.instructionBlock(instruction),
					blockEvents = eventsByBlock.get(block) ?? [];
				if (reads) {
					readers.push(instruction);
					readBlocks.add(block);
					if (!definitions.has(block)) upwardExposedReadBlocks.add(block);
				}
				const definition = defines ? nextVersion++ : undefined;
				if (definition !== undefined) {
					definitions.add(block);
					if (value !== undefined) valueByVersion.set(definition, value);
					if (partition.kind === "exact" && !heapLocation(partition.location))
						exactWriteKillRequirements.set(definition, {
							instruction,
							slot: killSlotByFamily.get(coreMemoryLocationFamily(partition.location))!,
						});
				}
				blockEvents.push({ instruction, reads, definition });
				eventsByBlock.set(block, blockEvents);
				touchedBlocks.add(block);
				events++;
			}
			addStatistics({
				events,
				partitions: partition.kind === "kill" ? 0 : 1,
				exactPartitions: partition.kind === "exact" ? 1 : 0,
				familyWidenings,
				touchedBlocks: touchedBlocks.size - statistics.touchedBlocks,
			});
			return { eventsByBlock, readers, readBlocks, definitions, upwardExposedReadBlocks };
		});
	const hasExceptionalEdges = cfg.reversePostorder.some((block) =>
		(cfg.successors[block] ?? []).some((edge) => edge.kind === "exceptional"),
	);
	const hasSinglePredecessorFlow = cfg.reversePostorder.every((block) => {
		if (block === fn.entry) return true;
		const incoming = (cfg.predecessors[block] ?? []).filter((edge) =>
			cfg.reachable.has(edge.from),
		);
		return incoming.length === 1 && incoming[0]!.kind === "ordinary";
	});
	let dominance:
		| {
				readonly dominancePosition: ReadonlyMap<CoreBlockId, number>;
				readonly dominanceFrontiers: ReadonlyMap<CoreBlockId, ReadonlySet<CoreBlockId>>;
		  }
		| undefined;
	const getDominance = () => {
		if (dominance !== undefined) return dominance;
		const dominatorChildren = new Map<CoreBlockId, Array<CoreBlockId>>();
		for (const block of cfg.reversePostorder) {
			const parent = cfg.immediateDominators[block];
			if (parent === null || parent === undefined) continue;
			const children = dominatorChildren.get(parent) ?? [];
			children.push(block);
			dominatorChildren.set(parent, children);
		}
		const dominanceOrder: Array<CoreBlockId> = [];
		const dominancePending = [fn.entry];
		while (dominancePending.length > 0) {
			const block = dominancePending.pop()!;
			dominanceOrder.push(block);
			const children = dominatorChildren.get(block) ?? [];
			for (let index = children.length - 1; index >= 0; index--)
				dominancePending.push(children[index]!);
		}

		const dominancePosition = new Map<CoreBlockId, number>();
		for (const [position, block] of dominanceOrder.entries())
			dominancePosition.set(block, position);
		const dominanceFrontiers = new Map<CoreBlockId, Set<CoreBlockId>>();
		for (const block of dominanceOrder) dominanceFrontiers.set(block, new Set());
		for (
			let index = hasSinglePredecessorFlow ? -1 : dominanceOrder.length - 1;
			index >= 0;
			index--
		) {
			const block = dominanceOrder[index]!;
			for (const edge of cfg.successors[block] ?? []) {
				if (cfg.immediateDominators[edge.to] !== block)
					dominanceFrontiers.get(block)!.add(edge.to);
			}
			for (const child of dominatorChildren.get(block) ?? []) {
				for (const frontier of dominanceFrontiers.get(child) ?? []) {
					if (cfg.immediateDominators[frontier] !== block)
						dominanceFrontiers.get(block)!.add(frontier);
				}
			}
		}

		return (dominance = { dominancePosition, dominanceFrontiers });
	};
	const solved: Array<ReadonlyMap<CoreInstructionId, number> | undefined> = [];
	const solvedReads = new Set<CoreInstructionId>();
	const solveSlot = (slot: number): ReadonlyMap<CoreInstructionId, number> => {
		const known = solved[slot];
		if (known !== undefined) return known;
		return runOwner(CORE_OPTIMIZATION_OWNER.memoryVersions, () => {
			const readVersions = new Map<CoreInstructionId, number>();
			const phiOperands = new Map<number, Array<number>>();
			let transfers = 0;
			const { eventsByBlock, readers, readBlocks, definitions, upwardExposedReadBlocks } =
				prepareColumn(slot);
			if (definitions.size === 0 && !hasExceptionalEdges) {
				for (const instruction of readers)
					readVersions.set(instruction, entryIdentity(slot));
				transfers = readBlocks.size;
			} else if (readBlocks.size > 0) {
				const { dominancePosition, dominanceFrontiers } = getDominance();
				const phiBlocks = new Set<CoreBlockId>();
				if (!hasSinglePredecessorFlow) {
					const liveIn = new Set<CoreBlockId>();
					const livePending = [...upwardExposedReadBlocks];
					while (livePending.length > 0) {
						const block = livePending.pop()!;
						if (liveIn.has(block)) continue;
						liveIn.add(block);
						for (const edge of cfg.predecessors[block] ?? []) {
							if (edge.kind === "exceptional" || definitions.has(edge.from)) continue;
							livePending.push(edge.from);
						}
					}
					const phiPending = [...definitions];
					for (const block of liveIn) {
						if (
							(cfg.predecessors[block] ?? []).some(({ kind }) => kind === "exceptional")
						) {
							phiBlocks.add(block);
							phiPending.push(block);
						}
					}
					for (let next = 0; next < phiPending.length; next++) {
						for (const frontier of dominanceFrontiers.get(phiPending[next]!) ?? []) {
							if (!liveIn.has(frontier) || phiBlocks.has(frontier)) continue;
							phiBlocks.add(frontier);
							if (!definitions.has(frontier)) phiPending.push(frontier);
						}
					}
				}
				const relevantBlocks = new Set<CoreBlockId>([
					...readBlocks,
					...definitions,
					...phiBlocks,
				]);
				for (const block of phiBlocks) {
					const phi = phiIdentity(block, slot);
					phiOperands.set(phi, []);
					for (const edge of cfg.predecessors[block] ?? []) relevantBlocks.add(edge.from);
				}
				const orderedBlocks = [...relevantBlocks]
					.filter((block) => dominancePosition.has(block))
					.sort(
						(left, right) => dominancePosition.get(left)! - dominancePosition.get(right)!,
					);
				const active: Array<{
					readonly block: CoreBlockId;
					readonly version: number;
				}> = [];
				for (const block of orderedBlocks) {
					while (active.length > 0 && !cfg.dominates(active.at(-1)!.block, block))
						active.pop();
					let version = active.at(-1)?.version ?? entryIdentity(slot);
					if (phiBlocks.has(block)) version = phiIdentity(block, slot);
					for (const event of eventsByBlock.get(block) ?? []) {
						if (event.reads) {
							readVersions.set(event.instruction, version);
						}
						version = event.definition ?? version;
					}
					for (const edge of cfg.successors[block] ?? []) {
						if (!phiBlocks.has(edge.to)) continue;
						phiOperands
							.get(phiIdentity(edge.to, slot))!
							.push(
								edge.kind === "exceptional" ? exceptionIdentity(block, slot) : version,
							);
					}
					active.push({ block, version });
					transfers++;
				}
			}
			const aliases = new Map<number, number>();
			const resolveVersion = (version: number): number => {
				let resolved = version;
				while (aliases.has(resolved)) resolved = aliases.get(resolved)!;
				let current = version;
				while (aliases.has(current) && aliases.get(current) !== resolved) {
					const next = aliases.get(current)!;
					aliases.set(current, resolved);
					current = next;
				}
				return resolved;
			};
			const dependentPhis = new Map<number, Set<number>>();
			for (const [phi, operands] of phiOperands) {
				for (const operand of operands) {
					const dependents = dependentPhis.get(operand) ?? new Set<number>();
					dependents.add(phi);
					dependentPhis.set(operand, dependents);
				}
			}
			const trivialPhiPending = [...phiOperands.keys()];
			for (let next = 0; next < trivialPhiPending.length; next++) {
				const phi = trivialPhiPending[next]!;
				if (aliases.has(phi)) continue;
				let replacement: number | undefined;
				let conflicting = false;
				for (const operand of phiOperands.get(phi)!) {
					const resolved = resolveVersion(operand);
					if (resolved === phi) continue;
					if (replacement === undefined) replacement = resolved;
					else if (replacement !== resolved) {
						conflicting = true;
						break;
					}
				}
				if (replacement === undefined || conflicting) continue;
				aliases.set(phi, replacement);
				trivialPhiPending.push(...(dependentPhis.get(phi) ?? []));
			}

			const previousRows = solvedReads.size;
			for (const [instruction, version] of readVersions) {
				readVersions.set(instruction, resolveVersion(version));
				solvedReads.add(instruction);
			}
			const delta = {
				solvedPartitions: 1,
				stateRows: solvedReads.size - previousRows + phiOperands.size,
				stateEntries:
					readVersions.size +
					[...phiOperands.values()].reduce(
						(total, operands) => total + operands.length,
						0,
					),
				phis: phiOperands.size - aliases.size,
				transfers,
				blockUpdates: phiOperands.size,
			};
			statistics.solvedPartitions++;
			statistics.stateRows += delta.stateRows;
			statistics.stateEntries += delta.stateEntries;
			statistics.phis += delta.phis;
			statistics.transfers += delta.transfers;
			statistics.blockUpdates += delta.blockUpdates;
			solved[slot] = readVersions;
			recordResult?.({ statistics: delta });
			return readVersions;
		});
	};
	const readVersions = new Map<CoreInstructionId, ReadonlySet<number>>();
	const versionsForRead = (
		instruction: CoreInstructionId,
	): ReadonlySet<number> | undefined => {
		const known = readVersions.get(instruction);
		if (known !== undefined) return known;
		const slots = slotsForRead(instruction);
		if (slots === undefined) return undefined;
		const versions = new Set<number>();
		for (const slot of slots) {
			const version = solveSlot(slot).get(instruction);
			if (version !== undefined) versions.add(version);
		}
		readVersions.set(instruction, versions);
		return versions;
	};
	const readHashes = new Map<CoreInstructionId, number>();
	return Object.freeze({
		function: fn.id,
		get statistics() {
			return Object.freeze({ ...statistics });
		},
		readHash(instruction: CoreInstructionId) {
			const cached = readHashes.get(instruction);
			if (cached !== undefined) return cached;
			const versions = versionsForRead(instruction);
			if (versions === undefined || versions.size === 0) return undefined;
			let sum = 0,
				xor = 0;
			for (const version of versions) {
				const mixed = Math.imul(version ^ 2_166_136_261, 16_777_619) >>> 0;
				sum = (sum + mixed) >>> 0;
				xor ^= mixed;
			}
			const hash = Math.imul(sum ^ xor ^ versions.size, 16_777_619) >>> 0;
			readHashes.set(instruction, hash);
			return hash;
		},
		readsEquivalent(left: CoreInstructionId, right: CoreInstructionId) {
			const leftVersions = versionsForRead(left),
				rightVersions = versionsForRead(right);
			if (leftVersions === undefined || rightVersions === undefined)
				return leftVersions === rightVersions;
			return (
				leftVersions.size === rightVersions.size &&
				[...leftVersions].every((version) => rightVersions.has(version))
			);
		},
		valueForRead(instruction: CoreInstructionId, location: CoreExactMemoryLocation) {
			const slots = slotsForRead(instruction);
			const slot = slotByLocation.get(locationTable.id(location));
			if (slot === undefined || !slots?.has(slot)) return undefined;
			const version = solveSlot(slot).get(instruction);
			if (version === undefined) return undefined;
			const requirement = exactWriteKillRequirements.get(version);
			if (requirement !== undefined) {
				const kills = solveSlot(requirement.slot);
				if (kills.get(instruction) !== kills.get(requirement.instruction))
					return undefined;
			}
			return valueByVersion.get(version);
		},
	});
}

const MEMORY_FUNCTION_DEPENDENCIES = [
	"body",
	"cfg",
	"exceptionFlow",
	"memoryEffects",
] as const;
const EMPTY_MEMORY_STATISTICS: CoreMemoryVersions["statistics"] = Object.freeze({
	accesses: 0,
	indexedInstructions: 0,
	heapAccessesResolved: 0,
	events: 0,
	partitions: 0,
	exactPartitions: 0,
	solvedPartitions: 0,
	touchedBlocks: 0,
	stateRows: 0,
	stateEntries: 0,
	phis: 0,
	transfers: 0,
	familyWidenings: 0,
	blockUpdates: 0,
});

function memoryVersions(
	program: CoreProgram,
	functionId: CoreFunctionId,
	dependencies: () => {
		readonly control: CoreControlFlow;
		readonly provenance: () => CoreProvenance;
		readonly roots: () => ReadonlyMap<CoreValueId, CoreValueId>;
	},
	runOwner: CoreOptimizationOwnerRunner = runWithoutOwner,
	recordResult?: (value: unknown) => void,
): CoreMemoryVersions {
	const fn = program.function(functionId),
		generation = program.generation,
		versions = fn.versions,
		dataVersion = program.programVersion("data");
	let prepared: CoreMemoryVersions | undefined;
	const current = () => {
		if (
			program.generation !== generation ||
			program.function(functionId) !== fn ||
			!MEMORY_FUNCTION_DEPENDENCIES.every(
				(domain) => versions[domain] === fn.version(domain),
			) ||
			program.programVersion("data") !== dataVersion
		)
			throw new Error("Stale memory-version analysis");
		if (prepared === undefined) {
			prepared = runOwner(CORE_OPTIMIZATION_OWNER.memoryVersions, () => {
				const { control, provenance, roots } = dependencies();
				return prepareMemoryVersions(
					fn,
					control,
					provenance,
					roots,
					runOwner,
					recordResult,
				);
			});
			recordResult?.({ statistics: prepared.statistics });
		}
		return prepared;
	};
	return Object.freeze({
		function: functionId,
		get statistics() {
			return prepared?.statistics ?? EMPTY_MEMORY_STATISTICS;
		},
		readHash(instruction: CoreInstructionId) {
			return current().readHash(instruction);
		},
		readsEquivalent(left: CoreInstructionId, right: CoreInstructionId) {
			return current().readsEquivalent(left, right);
		},
		valueForRead(instruction: CoreInstructionId, location: CoreExactMemoryLocation) {
			return current().valueForRead(instruction, location);
		},
	});
}

export function analyzeCoreMemoryVersions(
	program: CoreProgram,
	functionId: CoreFunctionId,
): CoreMemoryVersions {
	return memoryVersions(program, functionId, () => {
		const fn = program.function(functionId),
			control = buildCoreControlFlow(program, functionId);
		let canonical: ReadonlyMap<CoreValueId, CoreValueId> | undefined,
			provenance: CoreProvenance | undefined;
		const roots = () => (canonical ??= coreCanonicalValueRoots(fn, control));
		return {
			control,
			roots,
			provenance: () =>
				(provenance ??= buildCoreProvenance(program, fn, control, {
					canonicalRoots: roots(),
				})),
		};
	});
}

export const coreMemoryVersions = analyzeCoreMemoryVersions;

export const CORE_LOCAL_MEMORY_VERSIONS_ANALYSIS: CoreAnalysisDefinition<CoreMemoryVersions> =
	{
		key: "local-memory-versions",
		scope: "function",
		owner: CORE_OPTIMIZATION_OWNER.memoryVersions,
		functionDependencies: MEMORY_FUNCTION_DEPENDENCIES,
		programDependencies: ["data"],
		compute({ program, request, get, runOwner, recordResult }) {
			if (request.scope !== "function")
				throw new Error("Expected function analysis request");
			return memoryVersions(
				program,
				request.function,
				() => {
					return {
						control: get(CORE_CONTROL_FLOW_BUNDLE_ANALYSIS, request).exceptional(),
						provenance: () => get(CORE_LOCAL_FACT_BUNDLE_ANALYSIS, request).provenance,
						roots: () => get(CORE_LOCAL_FACT_BUNDLE_ANALYSIS, request).roots,
					};
				},
				runOwner,
				recordResult,
			);
		},
	};
