import {
	selectNativeRootStorage,
	validateNativeRootStorage,
} from "../../src/compiler/target/lower-native-roots.ts";
import {
	nativeInactiveRootMasks,
	nativeRootMaskWordHex,
} from "../../src/compiler/target/native-root-masks.ts";

for (const ordinal of [31, 32, 127, 128, 129, 255, 256, 2048]) {
	const registers = [0, 1, 2, 3];
	const native = {
		mode: "direct",
		storageValues: registers,
		body: {
			parameterCount: 1,
			argumentSnapshotCount: 0,
			instructions: Array.from({ length: ordinal + 2 }, () => ({
				opcode: "CREATE_UNDEFINED",
				dst: 0,
			})),
		},
		gc: {
			safepoints: Array.from({ length: ordinal + 2 }, (_, instructionIp) => {
				const roots =
					instructionIp < ordinal ? [0] : instructionIp === ordinal ? [0, 1, 2] : [0, 3];
				return {
					instructionIp,
					rootRegisters: roots,
				};
			}),
		},
	};
	const storage = selectNativeRootStorage(
		native,
		registers,
		new Set([1, 2, 3]),
		new Set(),
	);
	if (storage.rootSlotCount !== 3) throw new Error(`wrong frame size at ${ordinal}`);
	const slots = storage.rootSlots;
	if (slots[1] === slots[2]) throw new Error(`interference lost at ${ordinal}`);
	if (slots[1] !== slots[3]) throw new Error(`disjoint sharing lost at ${ordinal}`);
	if (slots.slice(1).includes(slots[0])) throw new Error("entry root was shared");
	validateNativeRootStorage(native, registers, storage);
	let rejected = false;
	try {
		validateNativeRootStorage(native, registers, {
			rootSlots: [slots[0], slots[1], slots[1], slots[3]],
			rootSlotCount: storage.rootSlotCount,
		});
	} catch (error) {
		rejected = error.message.includes("interfering GC roots");
	}
	if (!rejected) throw new Error(`physical collision accepted at ${ordinal}`);
}

for (const [slot, hex] of [
	[31, "80000000"],
	[32, "100000000"],
	[63, "8000000000000000"],
	[64, "1"],
	[127, "8000000000000000"],
	[128, "1"],
	[129, "2"],
	[255, "8000000000000000"],
	[256, "1"],
	[2048, "1"],
]) {
	const masks = nativeInactiveRootMasks(
		[[], [0], [], [0]].map((rootRegisters, instructionIp) => ({
			instructionIp,
			rootRegisters,
		})),
		new Map([[0, slot]]),
	);
	const mask = masks.get(0);
	if (mask.length !== Math.floor(slot / 32) + 1)
		throw new Error(`root mask truncated at ${slot}`);
	if (masks.get(1).length !== 0 || masks.get(3) !== masks.get(1))
		throw new Error(`zero reset lost at ${slot}`);
	if (masks.get(2) !== mask) throw new Error(`equal mask identity lost at ${slot}`);
	for (let word = 0; word < mask.length; word += 2) {
		const expected = word === Math.floor(slot / 64) * 2 ? hex : "0";
		if (nativeRootMaskWordHex(mask, word) !== expected)
			throw new Error(`root mask word differs at ${slot}/${word}`);
	}
}

console.log("native-root-planner PASS");
