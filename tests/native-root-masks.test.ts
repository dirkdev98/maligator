import { describe, expect, it } from "vitest";
import {
	nativeInactiveRootMasks,
	nativeRootMaskWordHex,
} from "../src/compiler/target/native-root-masks.ts";
import type { NativeFunctionPlan } from "../src/compiler/target/program-image.ts";

function points(roots: ReadonlyArray<ReadonlyArray<number>>) {
	return roots.map((rootRegisters, instructionIp) => ({
		kind: "operation" as const,
		instructionIp,
		rootRegisters,
		incomingRootRegisters: rootRegisters,
		outgoingRootRegisters: rootRegisters,
	})) satisfies NativeFunctionPlan["gc"]["safepoints"];
}

describe("native inactive-root masks", () => {
	it("preserves physical bits and interior zero words beyond both host integer widths", () => {
		const slots = [0, 31, 32, 63, 64, 127, 128, 129, 255, 256, 2048];
		for (const slot of slots) {
			const masks = nativeInactiveRootMasks(
				points([[], [0], [], [0]]),
				new Map([[0, slot]]),
			);
			const mask = masks.get(0)!;
			const words = Array(Math.floor(slot / 32) + 1).fill(0);
			words[Math.floor(slot / 32)] = (1 << (slot & 31)) >>> 0;
			expect(mask).toEqual(words);
			expect(masks.get(1)).toEqual([]);
			expect(masks.get(2)).toBe(mask);
			expect(masks.get(3)).toBe(masks.get(1));
			for (let word = 0; word < mask.length; word += 2) {
				const expected = ((1n << BigInt(slot)) >> BigInt(word * 32)) & ((1n << 64n) - 1n);
				expect(nativeRootMaskWordHex(mask, word)).toBe(expected.toString(16));
			}
		}
	});

	it("retains a shared physical slot when any occupant is live and omits all-active masks", () => {
		const slots = new Map([
			[0, 128],
			[1, 128],
		]);
		expect(nativeInactiveRootMasks(points([[0], [1]]), slots).size).toBe(0);
		const masks = nativeInactiveRootMasks(points([[], [1]]), slots);
		expect(masks.get(0)).toEqual([0, 0, 0, 0, 1]);
		expect(masks.get(1)).toEqual([]);
		expect(nativeRootMaskWordHex([0xffffffff, 0xffffffff], 0)).toBe("ffffffffffffffff");
	});
});
