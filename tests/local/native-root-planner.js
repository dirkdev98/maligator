import {
	selectNativeRootStorage,
	validateNativeRootStorage,
} from "../../src/compiler/target/lower-native-roots.ts";

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

console.log("native-root-planner PASS");
