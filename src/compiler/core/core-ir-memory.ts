import type { CoreAnalysisDefinition } from "./core-analysis-manager.ts";
import {
	CORE_CONTROL_FLOW_ANALYSIS,
	buildCoreControlFlow,
} from "./core-ir-control-flow.ts";
import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import { coreInstructionEffects } from "./core-ir-opcodes.ts";
import {
	CORE_LOCAL_PROVENANCE_ANALYSIS,
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

export type CoreMemoryPartition = string & {
	readonly __coreMemoryPartition: unique symbol;
};

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

export function coreMemoryDomainPartition(domain: CoreEffectDomain): CoreMemoryPartition {
	return `domain\0${domain}` as CoreMemoryPartition;
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
	readVersion(
		instruction: CoreInstructionId,
		partition: CoreMemoryPartition,
	): CoreMemoryVersion | undefined;
	valueForRead(
		instruction: CoreInstructionId,
		partition: CoreMemoryPartition,
	): CoreValueId | undefined;
	initializationVersion(
		instruction: CoreInstructionId,
		partition: CoreMemoryPartition,
	): CoreMemoryVersion | undefined;
	writeVersion(
		instruction: CoreInstructionId,
		partition: CoreMemoryPartition,
	): CoreMemoryVersion | undefined;
	entryVersion(
		block: CoreBlockId,
		partition: CoreMemoryPartition,
	): CoreMemoryVersion | undefined;
	exitVersion(
		block: CoreBlockId,
		partition: CoreMemoryPartition,
	): CoreMemoryVersion | undefined;
	readers(partition: CoreMemoryPartition): ReadonlyArray<CoreInstructionId>;
}

interface PartitionInfo {
	readonly partition: CoreMemoryPartition;
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

function sameState(left: Float64Array | undefined, right: Float64Array): boolean {
	if (left === undefined || left.length !== right.length) return false;
	for (let index = 0; index < right.length; index++) {
		if (left[index] !== right[index]) return false;
	}
	return true;
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
	const exactReads = new Map<CoreMemoryFamily, Set<CoreMemoryPartition>>();
	const exactLocations = new Map<CoreMemoryPartition, CoreExactMemoryLocation>();
	let accessCount = 0;
	for (const instruction of fn.instructionIds()) {
		if (fn.instructionKind(instruction) !== "operation") continue;
		const accesses = coreMemoryAccesses(fn, instruction, resolution);
		accessCount += accesses.length;
		accessesByInstruction[instruction] = accesses;
		for (const access of accesses) {
			if (access.mode !== "read" || !coreMemoryLocationIsExact(access.location)) continue;
			const partition = coreMemoryPartition(access.location);
			const family = coreMemoryLocationFamily(access.location);
			const partitions = exactReads.get(family) ?? new Set<CoreMemoryPartition>();
			partitions.add(partition);
			exactReads.set(family, partitions);
			exactLocations.set(partition, access.location);
		}
	}
	const acceptedExact = new Set<CoreMemoryPartition>();
	for (const partitions of exactReads.values()) {
		if (partitions.size <= MAX_EXACT_PARTITIONS_PER_FAMILY) {
			for (const partition of partitions) acceptedExact.add(partition);
		}
	}
	const partitions: Array<PartitionInfo> = CORE_EFFECT_DOMAINS.map((domain) => ({
		partition: coreMemoryDomainPartition(domain),
		protectedLocalHeap: false,
	}));
	for (const partition of acceptedExact) {
		const location = exactLocations.get(partition)!;
		partitions.push({
			partition,
			family: coreMemoryLocationFamily(location),
			protectedLocalHeap: location.kind === "object-slot" || location.kind === "element",
		});
	}
	const slotByPartition = new Map(
		partitions.map(({ partition }, slot) => [partition, slot]),
	);
	const domainSlot = new Map(
		CORE_EFFECT_DOMAINS.map((domain) => [
			domain,
			slotByPartition.get(coreMemoryDomainPartition(domain))!,
		]),
	);
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
	const entryStates = new Array<Float64Array | undefined>(fn.blockCapacity);
	const exitStates = new Array<Float64Array | undefined>(fn.blockCapacity);
	const readStates = new Array<Float64Array | undefined>(fn.instructionCapacity);
	const writeVersions = new Array<Map<number, number> | undefined>(
		fn.instructionCapacity,
	);
	const initializationVersions = new Array<Map<number, number> | undefined>(
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
	let transfers = 0;
	let blockUpdates = 0;
	const domainsForFamily = (family: CoreMemoryFamily): ReadonlyArray<CoreEffectDomain> =>
		CORE_MEMORY_FAMILY_DOMAINS[family];
	const killDomain = (
		state: Float64Array,
		domain: CoreEffectDomain,
		identity: (slot: number) => number,
	): void => {
		const domainId = domainSlot.get(domain)!;
		state[domainId] = identity(domainId);
		for (let slot = CORE_EFFECT_DOMAINS.length; slot < slotCount; slot++) {
			const info = partitions[slot]!;
			if (
				info.protectedLocalHeap ||
				info.family === undefined ||
				!domainsForFamily(info.family).includes(domain)
			)
				continue;
			state[slot] = identity(slot);
		}
	};
	const slotForAccess = (access: CoreMemoryAccess): number | undefined => {
		if (!coreMemoryLocationIsExact(access.location)) return undefined;
		return slotByPartition.get(coreMemoryPartition(access.location));
	};
	const initializeAllocation = (
		instruction: CoreInstructionId,
		state: Float64Array,
	): void => {
		const layout = layoutByInstruction[instruction];
		if (layout?.kind !== "named-slots") return;
		let versions: Map<number, number> | undefined;
		for (const [index, key] of layout.keys.entries()) {
			const partition = coreMemoryPartition({
				kind: "object-slot",
				allocation: instruction,
				key,
			});
			const slot = slotByPartition.get(partition);
			const value = layout.initialValues[index];
			if (slot === undefined || value === undefined) continue;
			const version = writeIdentity(instruction, slot);
			state[slot] = version;
			valueByVersion.set(version, value);
			versions ??= new Map();
			versions.set(slot, version);
		}
		if (versions !== undefined) initializationVersions[instruction] = versions;
	};
	const transfer = (block: CoreBlockId, entry: Float64Array): Float64Array => {
		transfers++;
		const state = entry.slice();
		for (const instruction of fn.instructionIds(block)) {
			if (fn.instructionKind(instruction) !== "operation") continue;
			const accesses = accessesByInstruction[instruction] ?? [];
			if (accesses.some((access) => access.mode === "read")) {
				readStates[instruction] = state.slice();
			}
			initializeAllocation(instruction, state);
			const effects = coreInstructionEffects(fn, instruction);
			const coveredWrites = new Set<CoreEffectDomain>();
			let versions: Map<number, number> | undefined;
			for (const access of accesses) {
				if (access.mode !== "write") continue;
				const family = coreMemoryLocationFamily(access.location);
				const exactAccess = coreMemoryLocationIsExact(access.location);
				const exactSlot = slotForAccess(access);
				if (exactSlot !== undefined) {
					const version = writeIdentity(instruction, exactSlot);
					state[exactSlot] = version;
					if (access.value !== undefined) valueByVersion.set(version, access.value);
					versions ??= new Map();
					versions.set(exactSlot, version);
				}
				for (const domain of domainsForFamily(family)) {
					coveredWrites.add(domain);
					if (!exactAccess) {
						killDomain(state, domain, (slot) => writeIdentity(instruction, slot));
					} else {
						const slot = domainSlot.get(domain)!;
						state[slot] = writeIdentity(instruction, slot);
					}
				}
			}
			if (versions !== undefined) writeVersions[instruction] = versions;
			const universal = effects.callsUserCode || effects.maySuspend;
			for (const domain of CORE_EFFECT_DOMAINS) {
				if (!effects.writes.includes(domain) && !universal) continue;
				if (coveredWrites.has(domain) && !universal) continue;
				killDomain(state, domain, (slot) => writeIdentity(instruction, slot));
			}
		}
		return state;
	};
	const mergeEntry = (block: CoreBlockId): Float64Array => {
		const incoming = cfg.predecessors[block] ?? [];
		if (block === fn.entry || incoming.length === 0) {
			return Float64Array.from({ length: slotCount }, (_, slot) =>
				entryIdentity(block, slot),
			);
		}
		const merged = new Float64Array(slotCount);
		for (let slot = 0; slot < slotCount; slot++) {
			let first: number | undefined;
			let agrees = true;
			for (const edge of incoming) {
				const value =
					edge.kind === "exceptional"
						? exceptionIdentity(edge.from, slot)
						: exitStates[edge.from]?.[slot];
				if (value === undefined) continue;
				if (first === undefined) first = value;
				else if (first !== value) agrees = false;
			}
			merged[slot] =
				first === undefined
					? entryIdentity(block, slot)
					: agrees
						? first
						: phiIdentity(block, slot);
		}
		return merged;
	};
	const queue = [...cfg.reversePostorder];
	const queued = new Set(queue);
	for (let next = 0; next < queue.length; next++) {
		const block = queue[next]!;
		queued.delete(block);
		const entry = mergeEntry(block);
		const exit = transfer(block, entry);
		const changed =
			!sameState(entryStates[block], entry) || !sameState(exitStates[block], exit);
		entryStates[block] = entry;
		exitStates[block] = exit;
		if (!changed) continue;
		blockUpdates++;
		for (const edge of cfg.successors[block] ?? []) {
			if (!queued.has(edge.to)) {
				queued.add(edge.to);
				queue.push(edge.to);
			}
		}
	}
	for (const instruction of fn.instructionIds()) {
		for (const access of accessesByInstruction[instruction] ?? []) {
			if (access.mode !== "read") continue;
			const slot = slotForAccess(access);
			if (slot !== undefined) readersBySlot[slot]!.push(instruction);
		}
	}
	const partitionSlot = (partition: CoreMemoryPartition): number | undefined =>
		slotByPartition.get(partition);
	const stateEntries = [...entryStates, ...exitStates, ...readStates].reduce(
		(total, state) => total + (state?.length ?? 0),
		0,
	);
	let phis = 0;
	for (const block of fn.blockIds()) {
		const state = entryStates[block];
		if (state === undefined) continue;
		for (let slot = 0; slot < state.length; slot++) {
			if (state[slot] === phiIdentity(block, slot)) phis++;
		}
	}
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
			const state = readStates[instruction];
			const accesses = accessesByInstruction[instruction];
			if (state === undefined || accesses === undefined) return undefined;
			const versions = new Set<number>();
			for (const access of accesses) {
				if (access.mode !== "read") continue;
				const exact = slotForAccess(access);
				if (exact !== undefined) versions.add(state[exact]!);
				else
					for (const domain of domainsForFamily(
						coreMemoryLocationFamily(access.location),
					))
						versions.add(state[domainSlot.get(domain)!]!);
			}
			return versions.size === 0
				? undefined
				: [...versions].sort((left, right) => left - right).join(",");
		},
		readVersion(instruction, partition) {
			const slot = partitionSlot(partition);
			const value = slot === undefined ? undefined : readStates[instruction]?.[slot];
			return value === undefined ? undefined : (value as CoreMemoryVersion);
		},
		valueForRead(instruction, partition) {
			const version = this.readVersion(instruction, partition);
			return version === undefined ? undefined : valueByVersion.get(version);
		},
		initializationVersion(instruction, partition) {
			const slot = partitionSlot(partition);
			const value =
				slot === undefined ? undefined : initializationVersions[instruction]?.get(slot);
			return value === undefined ? undefined : (value as CoreMemoryVersion);
		},
		writeVersion(instruction, partition) {
			const slot = partitionSlot(partition);
			const value =
				slot === undefined ? undefined : writeVersions[instruction]?.get(slot);
			return value === undefined ? undefined : (value as CoreMemoryVersion);
		},
		entryVersion(block, partition) {
			const slot = partitionSlot(partition);
			const value = slot === undefined ? undefined : entryStates[block]?.[slot];
			return value === undefined ? undefined : (value as CoreMemoryVersion);
		},
		exitVersion(block, partition) {
			const slot = partitionSlot(partition);
			const value = slot === undefined ? undefined : exitStates[block]?.[slot];
			return value === undefined ? undefined : (value as CoreMemoryVersion);
		},
		readers(partition) {
			const slot = partitionSlot(partition);
			return slot === undefined ? [] : Object.freeze([...readersBySlot[slot]!]);
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
				get(CORE_LOCAL_PROVENANCE_ANALYSIS, request),
			);
		},
	};
