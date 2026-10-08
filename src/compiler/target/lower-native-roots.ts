import { nativeRootedOutputRegisters } from "./lower-native-root-publication.ts";
import type { NativeFunctionPlan } from "./program-image.ts";

export interface NativeRootStoragePlan {
	readonly rootSlots: ReadonlyArray<number>;
	readonly rootSlotCount: number;
}

export function selectNativeRootStorage(
	native: NativeFunctionPlan,
	registers: ReadonlyArray<number>,
	privateRegisters: ReadonlySet<number>,
	privateCallResultIps: ReadonlySet<number>,
): NativeRootStoragePlan {
	if (native.mode !== "direct" || native.storageValues === undefined)
		return {
			rootSlots: registers.map((_, slot) => slot),
			rootSlotCount: registers.length,
		};
	const fn = native.body;
	const pinned = new Set(
		registers.filter(
			(register) =>
				!privateRegisters.has(register) ||
				register < fn.parameterCount + fn.argumentSnapshotCount,
		),
	);
	// Helper output addresses and entry roots have storage lifetimes beyond instruction maps.
	for (const [ip, instruction] of fn.instructions.entries())
		for (const register of nativeRootedOutputRegisters(
			instruction,
			ip,
			privateCallResultIps,
		))
			pinned.add(register);
	const wordCount = Math.ceil(native.gc.safepoints.length / 32);
	const occupancy = new Map(
		registers
			.filter((register) => !pinned.has(register))
			.map((register) => [register, new Uint32Array(wordCount)]),
	);
	for (const [index, point] of native.gc.safepoints.entries()) {
		const word = Math.floor(index / 32);
		const bit = 1 << (index & 31);
		for (const register of point.rootRegisters) {
			const occupied = occupancy.get(register);
			if (occupied !== undefined) occupied[word]! |= bit;
		}
	}
	const slots = new Map<number, number>();
	for (const register of registers)
		if (pinned.has(register)) slots.set(register, slots.size);
	const base = slots.size;
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
	return {
		rootSlots: registers.map((register) => slots.get(register)!),
		rootSlotCount: base + colors.length,
	};
}

// Root omissions are checked by storage selection; interference checks only retained roots.
export function validateNativeRootStorage(
	native: NativeFunctionPlan,
	registers: ReadonlyArray<number>,
	storage: NativeRootStoragePlan,
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
}
