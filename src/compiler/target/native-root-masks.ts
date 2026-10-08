import type { NativeFunctionPlan } from "./program-image.ts";

export type NativeInactiveRootMask = ReadonlyArray<number>;

export function nativeInactiveRootMasks(
	safepoints: NativeFunctionPlan["gc"]["safepoints"],
	slotOfRegister: ReadonlyMap<number, number>,
): ReadonlyMap<number, NativeInactiveRootMask> {
	if (safepoints.length === 0 || slotOfRegister.size === 0) return new Map();
	let wordCount = 0;
	for (const slot of slotOfRegister.values())
		wordCount = Math.max(wordCount, Math.floor(slot / 32) + 1);
	const allSlots = new Array<number>(wordCount).fill(0);
	for (const slot of slotOfRegister.values()) {
		const word = Math.floor(slot / 32);
		allSlots[word] = (allSlots[word]! | (1 << (slot & 31))) >>> 0;
	}
	const masks = new Map<number, NativeInactiveRootMask>();
	const interned = new Map<string, NativeInactiveRootMask>();
	let removesAnyRoot = false;
	for (const safepoint of safepoints) {
		const words = [...allSlots];
		for (const register of safepoint.rootRegisters) {
			const slot = slotOfRegister.get(register);
			if (slot === undefined) continue;
			const word = Math.floor(slot / 32);
			words[word] = (words[word]! & ~(1 << (slot & 31))) >>> 0;
		}
		while (words.at(-1) === 0) words.pop();
		const key = words.join(",");
		let mask = interned.get(key);
		if (mask === undefined) {
			mask = words;
			interned.set(key, mask);
		}
		// Publication coalescing relies on equal masks sharing identity, including zero resets.
		masks.set(safepoint.instructionIp, mask);
		removesAnyRoot ||= mask.length !== 0;
	}
	return removesAnyRoot ? masks : new Map();
}

export function nativeRootMaskWordHex(
	mask: NativeInactiveRootMask,
	wordIndex: number,
): string {
	const low = mask[wordIndex] ?? 0;
	const high = mask[wordIndex + 1] ?? 0;
	return high === 0
		? low.toString(16)
		: `${high.toString(16)}${low.toString(16).padStart(8, "0")}`;
}
