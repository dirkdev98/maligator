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
	const occupancy = new Map(
		registers
			.filter((register) => !pinned.has(register))
			.map((register) => [register, 0n]),
	);
	for (const [index, point] of native.gc.safepoints.entries()) {
		const bit = 1n << BigInt(index);
		for (const register of point.rootRegisters) {
			const occupied = occupancy.get(register);
			if (occupied !== undefined) occupancy.set(register, occupied | bit);
		}
	}
	const slots = new Map<number, number>();
	for (const register of registers)
		if (pinned.has(register)) slots.set(register, slots.size);
	const base = slots.size;
	const colors: Array<bigint> = [];
	for (const [register, occupied] of occupancy) {
		let color = colors.findIndex((points) => (points & occupied) === 0n);
		if (color === -1) {
			color = colors.length;
			colors.push(0n);
		}
		colors[color] = colors[color]! | occupied;
		slots.set(register, base + color);
	}
	return {
		rootSlots: registers.map((register) => slots.get(register)!),
		rootSlotCount: base + colors.length,
	};
}
