import type { CoreAnalysisDefinition } from "./core-analysis-manager.ts";
import {
	CORE_CONTROL_FLOW_ANALYSIS,
	buildCoreControlFlow,
} from "./core-ir-control-flow.ts";
import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import { coreInstructionEffects } from "./core-ir-opcodes.ts";
import {
	CORE_LOCAL_FACT_BUNDLE_ANALYSIS,
	analyzeCoreProvenance,
} from "./core-ir-provenance.ts";
import type { CoreAccessKey, CoreOwnCell, CoreProvenance } from "./core-ir-provenance.ts";
import { CORE_EFFECT_DOMAINS, CORE_MEMORY_FAMILY_DOMAINS } from "./core-ir.ts";
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
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

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
): CoreExactMemoryLocation | undefined {
	const attributes = access.attributes ?? [];
	switch (access.family) {
		case "object-slot": {
			if (resolution === undefined || access.baseOperand === undefined) return undefined;
			const base = operandAt(fn, instruction, access.baseOperand);
			const key = declaredKey(fn, instruction, access);
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
			location: exactLocation(fn, instruction, access, resolution) ?? {
				kind: "family",
				family: access.family,
			},
			...(base === undefined ? {} : { base }),
			...(key === undefined ? {} : { key }),
			...(value === undefined ? {} : { value }),
			...(result === undefined ? {} : { result }),
		};
		accesses.push(Object.freeze(memoryAccess));
	}
	return Object.freeze(accesses);
}

export interface CoreMemoryVersions {
	readonly function: CoreFunctionId;
	readonly statistics: {
		readonly accesses: number;
		readonly partitions: number;
		readonly exactPartitions: number;
		readonly stateEntries: number;
		readonly phis: number;
		readonly transfers: number;
		readonly blockUpdates: number;
	};
	readKey(instruction: CoreInstructionId): string | undefined;
	valueForRead(
		instruction: CoreInstructionId,
		location: CoreExactMemoryLocation,
	): CoreValueId | undefined;
}

interface PartitionInfo {
	readonly family?: CoreMemoryFamily;
	readonly protectedLocalHeap: boolean;
}

const MAX_EXACT_PARTITIONS_PER_FAMILY = 256;

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

function memoryVersions(
	fn: CoreFunctionStore,
	cfg: CoreControlFlow,
	provenance: CoreProvenance,
): CoreMemoryVersions {
	const resolution = resolutionFor(provenance);
	const accessesByInstruction = new Array<ReadonlyArray<CoreMemoryAccess> | undefined>(
		fn.instructionCapacity,
	);
	const locationTable = new CoreMemoryLocationTable(CORE_EFFECT_DOMAINS.length);
	const exactReads = new Map<CoreMemoryFamily, Set<CoreMemoryLocationId>>();
	const exactLocations = new Map<CoreMemoryLocationId, CoreExactMemoryLocation>();
	let accessCount = 0;
	for (const instruction of fn.instructionIds()) {
		if (fn.instructionKind(instruction) !== "operation") continue;
		const accesses = coreMemoryAccesses(fn, instruction, resolution);
		accessCount += accesses.length;
		accessesByInstruction[instruction] = accesses;
		for (const access of accesses) {
			if (access.mode !== "read" || !coreMemoryLocationIsExact(access.location)) continue;
			const locationId = locationTable.id(access.location);
			const family = coreMemoryLocationFamily(access.location);
			const locations = exactReads.get(family) ?? new Set<CoreMemoryLocationId>();
			locations.add(locationId);
			exactReads.set(family, locations);
			exactLocations.set(locationId, access.location);
		}
	}
	const acceptedExact = new Set<CoreMemoryLocationId>();
	for (const locations of exactReads.values()) {
		if (locations.size <= MAX_EXACT_PARTITIONS_PER_FAMILY) {
			for (const location of locations) acceptedExact.add(location);
		}
	}
	const partitions: Array<PartitionInfo> = CORE_EFFECT_DOMAINS.map(() => ({
		protectedLocalHeap: false,
	}));
	const slotByLocation = new Map<CoreMemoryLocationId, number>();
	for (const locationId of acceptedExact) {
		const location = exactLocations.get(locationId)!;
		slotByLocation.set(locationId, partitions.length);
		partitions.push({
			family: coreMemoryLocationFamily(location),
			protectedLocalHeap: location.kind === "object-slot" || location.kind === "element",
		});
	}
	const domainSlot = new Map(CORE_EFFECT_DOMAINS.map((domain, slot) => [domain, slot]));
	const slotCount = partitions.length;
	const entryBase = 1;
	const phiBase = entryBase + fn.blockCapacity * slotCount;
	const writeBase = phiBase + fn.blockCapacity * slotCount;
	const exceptionBase = writeBase + fn.instructionCapacity * slotCount;
	const entryIdentity = (block: CoreBlockId, slot: number): number =>
		entryBase + block * slotCount + slot;
	const phiIdentity = (block: CoreBlockId, slot: number): number =>
		phiBase + block * slotCount + slot;
	const writeIdentity = (instruction: CoreInstructionId, slot: number): number =>
		writeBase + instruction * slotCount + slot;
	const exceptionIdentity = (block: CoreBlockId, slot: number): number =>
		exceptionBase + block * slotCount + slot;
	const readStateStart = new Int32Array(fn.instructionCapacity);
	readStateStart.fill(-1);
	const readStateCount = new Uint32Array(fn.instructionCapacity);
	const readStateSlots: Array<number> = [];
	const readStateVersions: Array<number> = [];
	const pendingReadVersions = new Array<Map<number, number> | undefined>(
		fn.instructionCapacity,
	);
	const valueByVersion = new Map<number, CoreValueId>();
	const readersBySlot = Array.from(
		{ length: slotCount },
		() => new Array<CoreInstructionId>(),
	);
	const layoutByInstruction = new Array<CoreProvenance["layouts"][number] | undefined>(
		fn.instructionCapacity,
	);
	for (const layout of provenance.layouts)
		layoutByInstruction[layout.instruction] = layout;
	const domainsForFamily = (family: CoreMemoryFamily): ReadonlyArray<CoreEffectDomain> =>
		CORE_MEMORY_FAMILY_DOMAINS[family];
	const slotsKilledByDomain = new Map<CoreEffectDomain, ReadonlyArray<number>>();
	for (const domain of CORE_EFFECT_DOMAINS) {
		const slots = [domainSlot.get(domain)!];
		for (let slot = CORE_EFFECT_DOMAINS.length; slot < slotCount; slot++) {
			const info = partitions[slot]!;
			if (
				info.protectedLocalHeap ||
				info.family === undefined ||
				!domainsForFamily(info.family).includes(domain)
			)
				continue;
			slots.push(slot);
		}
		slotsKilledByDomain.set(domain, Object.freeze(slots));
	}
	const slotForAccess = (access: CoreMemoryAccess): number | undefined => {
		if (!coreMemoryLocationIsExact(access.location)) return undefined;
		return slotByLocation.get(locationTable.id(access.location));
	};
	interface SparseMemoryEvent {
		readonly instruction: CoreInstructionId;
		readonly reads: ReadonlySet<number>;
		readonly definitions: ReadonlyMap<number, number>;
	}
	const eventsByBlock = new Array<ReadonlyArray<SparseMemoryEvent> | undefined>(
		fn.blockCapacity,
	);
	const definitionBlocksBySlot = Array.from(
		{ length: slotCount },
		() => new Set<CoreBlockId>(),
	);
	const readBlocksBySlot = Array.from(
		{ length: slotCount },
		() => new Set<CoreBlockId>(),
	);
	const upwardExposedReadBlocksBySlot = Array.from(
		{ length: slotCount },
		() => new Set<CoreBlockId>(),
	);
	const initializationDefinitions = (
		instruction: CoreInstructionId,
		definitions: Map<number, number>,
	): void => {
		const layout = layoutByInstruction[instruction];
		if (layout?.kind !== "named-slots") return;
		for (const [index, key] of layout.keys.entries()) {
			const location = locationTable.id({
				kind: "object-slot",
				allocation: instruction,
				key,
			});
			const slot = slotByLocation.get(location);
			const value = layout.initialValues[index];
			if (slot === undefined || value === undefined) continue;
			const version = writeIdentity(instruction, slot);
			definitions.set(slot, version);
			valueByVersion.set(version, value);
		}
	};
	for (const block of cfg.reversePostorder) {
		const events: Array<SparseMemoryEvent> = [];
		const definedInBlock = new Set<number>();
		for (const instruction of fn.instructionIds(block)) {
			if (fn.instructionKind(instruction) !== "operation") continue;
			const accesses = accessesByInstruction[instruction] ?? [];
			const reads = new Set<number>();
			for (const access of accesses) {
				if (access.mode !== "read") continue;
				const exact = slotForAccess(access);
				if (exact !== undefined) reads.add(exact);
				else
					for (const domain of domainsForFamily(
						coreMemoryLocationFamily(access.location),
					))
						reads.add(domainSlot.get(domain)!);
			}
			const definitions = new Map<number, number>();
			initializationDefinitions(instruction, definitions);
			const effects = coreInstructionEffects(fn, instruction);
			const coveredWrites = new Set<CoreEffectDomain>();
			for (const access of accesses) {
				if (access.mode !== "write") continue;
				const family = coreMemoryLocationFamily(access.location);
				const exactAccess = coreMemoryLocationIsExact(access.location);
				const exactSlot = slotForAccess(access);
				if (exactSlot !== undefined) {
					const version = writeIdentity(instruction, exactSlot);
					definitions.set(exactSlot, version);
					if (access.value !== undefined) valueByVersion.set(version, access.value);
				}
				for (const domain of domainsForFamily(family)) {
					coveredWrites.add(domain);
					if (!exactAccess) {
						for (const slot of slotsKilledByDomain.get(domain)!)
							definitions.set(slot, writeIdentity(instruction, slot));
					} else {
						const slot = domainSlot.get(domain)!;
						definitions.set(slot, writeIdentity(instruction, slot));
					}
				}
			}
			const universal = effects.callsUserCode || effects.maySuspend;
			for (const domain of CORE_EFFECT_DOMAINS) {
				if (!effects.writes.includes(domain) && !universal) continue;
				if (coveredWrites.has(domain) && !universal) continue;
				for (const slot of slotsKilledByDomain.get(domain)!)
					definitions.set(slot, writeIdentity(instruction, slot));
			}
			if (reads.size === 0 && definitions.size === 0) continue;
			for (const slot of reads) {
				readersBySlot[slot]!.push(instruction);
				readBlocksBySlot[slot]!.add(block);
				if (!definedInBlock.has(slot)) upwardExposedReadBlocksBySlot[slot]!.add(block);
			}
			for (const slot of definitions.keys()) {
				definedInBlock.add(slot);
				definitionBlocksBySlot[slot]!.add(block);
			}
			events.push(
				Object.freeze({
					instruction,
					reads,
					definitions,
				}),
			);
		}
		eventsByBlock[block] = Object.freeze(events);
	}
	const dominatorChildren = Array.from(
		{ length: fn.blockCapacity },
		() => new Array<CoreBlockId>(),
	);
	for (const block of cfg.reversePostorder) {
		const parent = cfg.immediateDominators[block];
		if (parent !== null && parent !== undefined) dominatorChildren[parent]!.push(block);
	}
	const dominanceOrder: Array<CoreBlockId> = [];
	const dominancePending = [fn.entry];
	while (dominancePending.length > 0) {
		const block = dominancePending.pop()!;
		dominanceOrder.push(block);
		const children = dominatorChildren[block]!;
		for (let index = children.length - 1; index >= 0; index--)
			dominancePending.push(children[index]!);
	}
	const phiOperands = new Map<number, Array<number>>();
	let transfers = 0;
	const recordReadVersion = (
		instruction: CoreInstructionId,
		slot: number,
		version: number,
	): void => {
		const versions = pendingReadVersions[instruction] ?? new Map();
		versions.set(slot, version);
		pendingReadVersions[instruction] = versions;
	};
	const hasSinglePredecessorFlow = cfg.reversePostorder.every((block) => {
		if (block === fn.entry) return true;
		const incoming = (cfg.predecessors[block] ?? []).filter(({ from }) =>
			cfg.reachable.has(from),
		);
		return incoming.length === 1 && incoming[0]!.kind === "ordinary";
	});
	if (hasSinglePredecessorFlow) {
		const versions = new Map<number, number>();
		type Frame =
			| { readonly kind: "enter"; readonly block: CoreBlockId }
			| {
					readonly kind: "exit";
					readonly changes: ReadonlyArray<{
						readonly slot: number;
						readonly previous: number | undefined;
					}>;
			  };
		const pending: Array<Frame> = [{ kind: "enter", block: fn.entry }];
		while (pending.length > 0) {
			const frame = pending.pop()!;
			if (frame.kind === "exit") {
				for (let index = frame.changes.length - 1; index >= 0; index--) {
					const { slot, previous } = frame.changes[index]!;
					if (previous === undefined) versions.delete(slot);
					else versions.set(slot, previous);
				}
				continue;
			}
			const changes: Array<{
				readonly slot: number;
				readonly previous: number | undefined;
			}> = [];
			const changed = new Set<number>();
			for (const event of eventsByBlock[frame.block] ?? []) {
				for (const slot of event.reads)
					recordReadVersion(
						event.instruction,
						slot,
						versions.get(slot) ?? entryIdentity(fn.entry, slot),
					);
				for (const [slot, version] of event.definitions) {
					if (!changed.has(slot)) {
						changed.add(slot);
						changes.push({ slot, previous: versions.get(slot) });
					}
					versions.set(slot, version);
				}
			}
			transfers++;
			pending.push({ kind: "exit", changes });
			const children = dominatorChildren[frame.block]!;
			for (let index = children.length - 1; index >= 0; index--)
				pending.push({ kind: "enter", block: children[index]! });
		}
	} else {
		const dominancePosition = new Int32Array(fn.blockCapacity);
		dominancePosition.fill(-1);
		for (const [position, block] of dominanceOrder.entries())
			dominancePosition[block] = position;
		const dominanceFrontiers = Array.from(
			{ length: fn.blockCapacity },
			() => new Set<CoreBlockId>(),
		);
		for (let index = dominanceOrder.length - 1; index >= 0; index--) {
			const block = dominanceOrder[index]!;
			for (const edge of cfg.successors[block] ?? []) {
				if (cfg.immediateDominators[edge.to] !== block)
					dominanceFrontiers[block]!.add(edge.to);
			}
			for (const child of dominatorChildren[block]!) {
				for (const frontier of dominanceFrontiers[child]!) {
					if (cfg.immediateDominators[frontier] !== block)
						dominanceFrontiers[block]!.add(frontier);
				}
			}
		}
		const hasExceptionalEdges = cfg.successors.some((edges) =>
			edges.some(({ kind }) => kind === "exceptional"),
		);
		for (let slot = 0; slot < slotCount; slot++) {
			const readBlocks = readBlocksBySlot[slot]!;
			if (readBlocks.size === 0) continue;
			const definitions = definitionBlocksBySlot[slot]!;
			if (definitions.size === 0 && !hasExceptionalEdges) {
				for (const instruction of readersBySlot[slot]!)
					recordReadVersion(instruction, slot, entryIdentity(fn.entry, slot));
				transfers += readBlocks.size;
				continue;
			}
			const liveIn = new Set<CoreBlockId>();
			const livePending = [...upwardExposedReadBlocksBySlot[slot]!];
			while (livePending.length > 0) {
				const block = livePending.pop()!;
				if (liveIn.has(block)) continue;
				liveIn.add(block);
				for (const edge of cfg.predecessors[block] ?? []) {
					if (edge.kind === "exceptional" || definitions.has(edge.from)) continue;
					livePending.push(edge.from);
				}
			}
			const phiBlocks = new Set<CoreBlockId>();
			const phiPending = [...definitions];
			for (const block of liveIn) {
				if ((cfg.predecessors[block] ?? []).some(({ kind }) => kind === "exceptional")) {
					phiBlocks.add(block);
					phiPending.push(block);
				}
			}
			for (let next = 0; next < phiPending.length; next++) {
				for (const frontier of dominanceFrontiers[phiPending[next]!]!) {
					if (!liveIn.has(frontier) || phiBlocks.has(frontier)) continue;
					phiBlocks.add(frontier);
					if (!definitions.has(frontier)) phiPending.push(frontier);
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
				.filter((block) => dominancePosition[block]! >= 0)
				.sort((left, right) => dominancePosition[left]! - dominancePosition[right]!);
			const active: Array<{ readonly block: CoreBlockId; readonly version: number }> = [];
			for (const block of orderedBlocks) {
				while (active.length > 0 && !cfg.dominates(active.at(-1)!.block, block))
					active.pop();
				let version = active.at(-1)?.version ?? entryIdentity(fn.entry, slot);
				if (phiBlocks.has(block)) version = phiIdentity(block, slot);
				for (const event of eventsByBlock[block] ?? []) {
					if (event.reads.has(slot)) {
						recordReadVersion(event.instruction, slot, version);
					}
					version = event.definitions.get(slot) ?? version;
				}
				for (const edge of cfg.successors[block] ?? []) {
					if (!phiBlocks.has(edge.to)) continue;
					phiOperands
						.get(phiIdentity(edge.to, slot))!
						.push(edge.kind === "exceptional" ? exceptionIdentity(block, slot) : version);
				}
				active.push({ block, version });
				transfers++;
			}
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
	for (const instruction of fn.instructionIds()) {
		const versions = pendingReadVersions[instruction];
		if (versions === undefined || versions.size === 0) continue;
		readStateStart[instruction] = readStateSlots.length;
		readStateCount[instruction] = versions.size;
		for (const [slot, version] of versions) {
			readStateSlots.push(slot);
			readStateVersions.push(resolveVersion(version));
		}
	}
	const stateEntries =
		readStateVersions.length +
		[...phiOperands.values()].reduce((total, operands) => total + operands.length, 0);
	const readStateVersion = (
		instruction: CoreInstructionId,
		slot: number,
	): number | undefined => {
		const start = readStateStart[instruction]!;
		if (start < 0) return undefined;
		const end = start + readStateCount[instruction]!;
		for (let index = start; index < end; index++) {
			if (readStateSlots[index] === slot) return readStateVersions[index];
		}
		return undefined;
	};
	const phis = phiOperands.size - aliases.size;
	const blockUpdates = phiOperands.size;
	const result: CoreMemoryVersions = {
		function: fn.id,
		statistics: Object.freeze({
			accesses: accessCount,
			partitions: slotCount,
			exactPartitions: slotCount - CORE_EFFECT_DOMAINS.length,
			stateEntries,
			phis,
			transfers,
			blockUpdates,
		}),
		readKey(instruction) {
			const start = readStateStart[instruction]!;
			if (start < 0) return undefined;
			const end = start + readStateCount[instruction]!;
			const versions = new Set<number>();
			for (let index = start; index < end; index++)
				versions.add(readStateVersions[index]!);
			return versions.size === 0
				? undefined
				: [...versions].sort((left, right) => left - right).join(",");
		},
		valueForRead(instruction, location) {
			const slot = slotByLocation.get(locationTable.id(location));
			const version =
				slot === undefined ? undefined : readStateVersion(instruction, slot);
			return version === undefined ? undefined : valueByVersion.get(version);
		},
	};
	return Object.freeze(result);
}

export function analyzeCoreMemoryVersions(
	program: CoreProgram,
	functionId: CoreFunctionId,
): CoreMemoryVersions {
	const fn = program.function(functionId);
	const provenance = analyzeCoreProvenance(program, functionId);
	return memoryVersions(fn, buildCoreControlFlow(program, functionId), provenance);
}

export const coreMemoryVersions = analyzeCoreMemoryVersions;

export const CORE_LOCAL_MEMORY_VERSIONS_ANALYSIS: CoreAnalysisDefinition<CoreMemoryVersions> =
	{
		key: "local-memory-versions",
		scope: "function",
		functionDependencies: ["body", "cfg", "exceptionFlow", "memoryEffects"],
		programDependencies: ["data"],
		compute({ program, request, get }) {
			if (request.scope !== "function")
				throw new Error("Expected function analysis request");
			return memoryVersions(
				program.function(request.function),
				get(CORE_CONTROL_FLOW_ANALYSIS, request),
				get(CORE_LOCAL_FACT_BUNDLE_ANALYSIS, request).provenance,
			);
		},
	};
