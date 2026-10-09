import { nativeRootedOutputRegisters } from "./lower-native-root-publication.ts";
import type { NativeBodyFacts } from "./native-body-facts.ts";
import type { NativeFunctionPlan } from "./program-image.ts";

export interface NativeRootStoragePlan {
	readonly rootSlots: ReadonlyArray<number>;
	readonly rootSlotCount: number;
}

/**
 * Continuously rooted registers whose emitted storage accesses are exactly their
 * instruction reads and writes, with the facts needed to compute their liveness.
 */
export interface NativeContinuousRootSharing {
	readonly registers: ReadonlySet<number>;
	readonly facts: Pick<NativeBodyFacts, "reads" | "writes" | "handlerTargets">;
}

export function selectNativeRootStorage(
	native: NativeFunctionPlan,
	registers: ReadonlyArray<number>,
	privateRegisters: ReadonlySet<number>,
	privateCallResultIps: ReadonlySet<number>,
	continuous?: NativeContinuousRootSharing,
): NativeRootStoragePlan {
	if (native.mode !== "direct" || native.storageValues === undefined)
		return {
			rootSlots: registers.map((_, slot) => slot),
			rootSlotCount: registers.length,
		};
	const fn = native.body;
	const entryRegisterCount = fn.parameterCount + fn.argumentSnapshotCount;
	// Entry roots are published before the first instruction map.
	const pinned = new Set(
		registers.filter(
			(register) =>
				register < entryRegisterCount ||
				(!privateRegisters.has(register) && continuous?.registers.has(register) !== true),
		),
	);
	// Private helper outputs are output roots at their own safepoint; continuously
	// rooted ones are written through an address the instruction maps do not bound.
	for (const [ip, instruction] of fn.instructions.entries())
		for (const register of nativeRootedOutputRegisters(
			instruction,
			ip,
			privateCallResultIps,
		))
			if (!privateRegisters.has(register)) pinned.add(register);
	const slots = new Map<number, number>();
	for (const register of registers)
		if (pinned.has(register)) slots.set(register, slots.size);
	const pinnedSlots = slots.size;
	const privateColors = colorBySafepointOccupancy(
		native,
		registers.filter(
			(register) => !pinned.has(register) && privateRegisters.has(register),
		),
		slots,
		pinnedSlots,
	);
	const continuousRegisters = registers.filter(
		(register) => !pinned.has(register) && !privateRegisters.has(register),
	);
	const continuousColors =
		continuousRegisters.length === 0
			? 0
			: colorByInstructionOccupancy(
					native,
					continuousRegisters,
					continuous!.facts,
					slots,
					pinnedSlots + privateColors,
				);
	return {
		rootSlots: registers.map((register) => slots.get(register)!),
		rootSlotCount: pinnedSlots + privateColors + continuousColors,
	};
}

/** Private values occupy their slot only where a GC map publishes them. */
function colorBySafepointOccupancy(
	native: NativeFunctionPlan,
	registers: ReadonlyArray<number>,
	slots: Map<number, number>,
	base: number,
): number {
	const wordCount = Math.ceil(native.gc.safepoints.length / 32);
	const occupancy = new Map(
		registers.map((register) => [register, new Uint32Array(wordCount)]),
	);
	for (const [index, point] of native.gc.safepoints.entries()) {
		const word = Math.floor(index / 32);
		const bit = 1 << (index & 31);
		for (const register of point.rootRegisters) {
			const occupied = occupancy.get(register);
			if (occupied !== undefined) occupied[word]! |= bit;
		}
	}
	const colors: Array<Uint32Array> = [];
	for (const [register, occupied] of occupancy) {
		let color = colors.findIndex((points) => {
			for (let word = 0; word < wordCount; word++)
				if ((points[word]! & occupied[word]!) !== 0) return false;
			return true;
		});
		if (color === -1) {
			color = colors.length;
			colors.push(new Uint32Array(wordCount));
		}
		for (let word = 0; word < wordCount; word++) colors[color]![word]! |= occupied[word]!;
		slots.set(register, base + color);
	}
	return colors.length;
}

/**
 * Continuously rooted values hold their slot from definition to last use, so two
 * of them share a slot only when no instruction has one live or written while the
 * other is live, written, or rooted by that instruction's GC map.
 */
function colorByInstructionOccupancy(
	native: NativeFunctionPlan,
	registers: ReadonlyArray<number>,
	facts: NativeContinuousRootSharing["facts"],
	slots: Map<number, number>,
	base: number,
): number {
	const fn = native.body;
	const count = fn.instructions.length;
	const ids = new Int32Array(fn.registerCount).fill(-1);
	for (const [id, register] of registers.entries()) ids[register] = id;
	const liveWords = Math.ceil(registers.length / 32);
	const liveIn = new Uint32Array(count * liveWords);
	const live = new Uint32Array(liveWords);
	const merge = (next: number) => {
		const offset = next * liveWords;
		for (let word = 0; word < liveWords; word++) live[word]! |= liveIn[offset + word]!;
	};
	const transfer = (ip: number) => {
		live.fill(0);
		const op = fn.instructions[ip]!;
		if (op.opcode === "JUMP") merge(op.targetIp);
		else {
			if (op.opcode === "JUMP_IF") merge(op.targetIp);
			if (op.opcode !== "RETURN" && op.opcode !== "THROW" && ip + 1 < count)
				merge(ip + 1);
		}
		for (const register of facts.writes[ip]!) {
			const id = ids[register]!;
			if (id >= 0) live[id >>> 5]! &= ~(1 << (id & 31));
		}
		// A throwing instruction may not have written its outputs before the handler runs.
		const handler = facts.handlerTargets[ip];
		if (handler !== undefined) merge(handler);
		for (const register of facts.reads[ip]!) {
			const id = ids[register]!;
			if (id >= 0) live[id >>> 5]! |= 1 << (id & 31);
		}
	};
	for (let changed = true; changed;) {
		changed = false;
		for (let ip = count - 1; ip >= 0; ip--) {
			transfer(ip);
			const offset = ip * liveWords;
			for (let word = 0; word < liveWords; word++) {
				if (liveIn[offset + word] === live[word]) continue;
				liveIn.set(live, offset);
				changed = true;
				break;
			}
		}
	}
	const safepointRoots = new Map(
		native.gc.safepoints.map((point) => [point.instructionIp, point.rootRegisters]),
	);
	const occupied = (visit: (id: number, ip: number) => void) => {
		for (let ip = 0; ip < count; ip++) {
			const offset = ip * liveWords;
			for (let word = 0; word < liveWords; word++) {
				let bits = liveIn[offset + word]!;
				while (bits !== 0) {
					const low = bits & -bits;
					visit(word * 32 + 31 - Math.clz32(low), ip);
					bits ^= low;
				}
			}
			for (const register of facts.writes[ip]!) {
				const id = ids[register]!;
				if (id >= 0) visit(id, ip);
			}
			for (const register of safepointRoots.get(ip) ?? []) {
				const id = ids[register]!;
				if (id >= 0) visit(id, ip);
			}
		}
	};
	const first = new Int32Array(registers.length).fill(count);
	const last = new Int32Array(registers.length).fill(-1);
	occupied((id, ip) => {
		if (ip < first[id]!) first[id] = ip;
		last[id] = ip;
	});
	const spans = registers.map((_, id) =>
		last[id]! < 0
			? new Uint32Array(0)
			: new Uint32Array((last[id]! >>> 5) - (first[id]! >>> 5) + 1),
	);
	occupied((id, ip) => {
		spans[id]![(ip >>> 5) - (first[id]! >>> 5)]! |= 1 << (ip & 31);
	});
	const colors: Array<Uint32Array> = [];
	for (const [id, register] of registers.entries()) {
		const span = spans[id]!;
		const offset = first[id]! >>> 5;
		let color = colors.findIndex((points) => {
			for (let word = 0; word < span.length; word++)
				if ((points[offset + word]! & span[word]!) !== 0) return false;
			return true;
		});
		if (color === -1) {
			color = colors.length;
			colors.push(new Uint32Array(Math.ceil(count / 32)));
		}
		for (let word = 0; word < span.length; word++)
			colors[color]![offset + word]! |= span[word]!;
		slots.set(register, base + color);
	}
	return colors.length;
}

/** Inputs that let validation recheck the continuous pool beyond safepoint interference. */
export interface NativeRootSharingFacts {
	readonly privateRegisters: ReadonlySet<number>;
	readonly facts: NativeContinuousRootSharing["facts"];
}

// Root omissions are checked by storage selection; interference checks only retained roots.
export function validateNativeRootStorage(
	native: NativeFunctionPlan,
	registers: ReadonlyArray<number>,
	storage: NativeRootStoragePlan,
	sharing?: NativeRootSharingFacts,
): void {
	const invalid = (reason: string): never => {
		throw new Error(`Native function has an invalid or stale storage plan: ${reason}`);
	};
	if (
		storage.rootSlots.length !== registers.length ||
		!Number.isSafeInteger(storage.rootSlotCount) ||
		storage.rootSlotCount < 0 ||
		storage.rootSlotCount > registers.length
	)
		invalid("invalid root frame size");
	const slots = new Map<number, number>();
	for (const [index, register] of registers.entries()) {
		const slot = storage.rootSlots[index]!;
		if (
			slots.has(register) ||
			!Number.isSafeInteger(slot) ||
			slot < 0 ||
			slot >= storage.rootSlotCount
		)
			invalid("invalid root slot");
		slots.set(register, slot);
	}
	const occupied = new Set<number>();
	for (const point of native.gc.safepoints) {
		occupied.clear();
		for (const register of point.rootRegisters) {
			const slot = slots.get(register);
			if (slot === undefined) continue;
			if (occupied.has(slot)) invalid(`interfering GC roots at ${point.instructionIp}`);
			occupied.add(slot);
		}
	}
	if (sharing === undefined) return;
	const groups = new Map<number, Array<number>>();
	for (const register of registers) {
		if (sharing.privateRegisters.has(register)) continue;
		const slot = slots.get(register)!;
		const group = groups.get(slot);
		if (group === undefined) groups.set(slot, [register]);
		else group.push(register);
	}
	const shared = [...groups.values()].filter((group) => group.length > 1);
	if (shared.length > 0) validateContinuousSlots(native, shared, sharing.facts, invalid);
}

/**
 * Non-private registers that share a slot rely on it between safepoints as well.
 * Their instruction lifetimes are recomputed per register by backward reachability
 * from reads, independently of the allocator's whole-function liveness bitsets.
 */
function validateContinuousSlots(
	native: NativeFunctionPlan,
	groups: ReadonlyArray<ReadonlyArray<number>>,
	facts: NativeRootSharingFacts["facts"],
	invalid: (reason: string) => never,
): void {
	const fn = native.body;
	const count = fn.instructions.length;
	const checked = new Set(groups.flat());
	const sites = () => new Map<number, Array<number>>();
	const reads = sites();
	const writes = sites();
	const rooted = sites();
	const note = (map: Map<number, Array<number>>, register: number, ip: number) => {
		if (!checked.has(register)) return;
		const ips = map.get(register);
		if (ips === undefined) map.set(register, [ip]);
		else ips.push(ip);
	};
	for (let ip = 0; ip < count; ip++) {
		for (const register of facts.reads[ip]!) note(reads, register, ip);
		for (const register of facts.writes[ip]!) note(writes, register, ip);
	}
	for (const point of native.gc.safepoints)
		for (const register of point.rootRegisters)
			note(rooted, register, point.instructionIp);
	// Handler edges leave before the protected instruction writes, so they never kill.
	const predecessors: Array<Array<{ ip: number; exceptional: boolean }>> = Array.from(
		{ length: count },
		() => [],
	);
	for (const [ip, op] of fn.instructions.entries()) {
		if (op.opcode === "JUMP" || op.opcode === "JUMP_IF")
			predecessors[op.targetIp]!.push({ ip, exceptional: false });
		if (
			op.opcode !== "JUMP" &&
			op.opcode !== "RETURN" &&
			op.opcode !== "THROW" &&
			ip + 1 < count
		)
			predecessors[ip + 1]!.push({ ip, exceptional: false });
		const handler = facts.handlerTargets[ip];
		if (handler !== undefined) predecessors[handler]!.push({ ip, exceptional: true });
	}
	const live = new Int32Array(count).fill(-1);
	const group = new Int32Array(count).fill(-1);
	const owner = new Int32Array(count);
	for (const [index, members] of groups.entries()) {
		for (const register of members) {
			const kills = new Set(writes.get(register));
			const work = [...(reads.get(register) ?? [])];
			for (const ip of work) live[ip] = register;
			for (let next = 0; next < work.length; next++)
				for (const edge of predecessors[work[next]!]!) {
					if (live[edge.ip] === register) continue;
					if (!edge.exceptional && kills.has(edge.ip)) continue;
					live[edge.ip] = register;
					work.push(edge.ip);
				}
			for (const ip of [...work, ...kills, ...(rooted.get(register) ?? [])]) {
				if (group[ip] === index && owner[ip] !== register)
					invalid(`continuous roots ${owner[ip]} and ${register} share a slot at ${ip}`);
				group[ip] = index;
				owner[ip] = register;
			}
		}
	}
}
