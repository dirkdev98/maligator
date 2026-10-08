import {
	selectNativeRootStorage,
	validateNativeRootStorage,
} from "../../src/compiler/target/lower-native-roots.ts";
import { lowerNativeSuspension } from "../../src/compiler/target/lower-native-suspension.ts";
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

for (const length of [32, 256, 2048]) {
	const registerCount = length + 320;
	const retained = registerCount - 1;
	const saved = [31, 32, 127, 128, 129, 255, 256, 286, retained];
	const transfer = { opcode: "AWAIT", awaitedSrc: 16, valueDst: 1, modeDst: 2 };
	const instructions = [
		transfer,
		...Array.from({ length }, () => ({ opcode: "CREATE_NUMBER", dst: 16, value: 1 })),
		transfer,
		...saved
			.filter((register) => register !== 286)
			.map((register) => ({ opcode: "MOVE", dst: 16, src: register })),
		{ opcode: "RETURN", value: 16 },
		{ opcode: "RETURN", value: 286 },
	];
	const native = {
		mode: "resumable",
		body: {
			registerCount,
			handlers: [
				{
					startIp: 0,
					endIp: instructions.length - 1,
					handlerIp: instructions.length - 1,
				},
			],
			instructions,
		},
		registerRepresentations: Array.from({ length: registerCount }, (_, register) =>
			register === 3 ? "boxed" : "number",
		),
		gc: {
			safepoints: [0, length + 1].map((instructionIp) => ({
				instructionIp,
				outgoingRootRegisters: [3],
			})),
		},
	};
	const plan = lowerNativeSuspension(native);
	const expected = [3, ...saved].join(",");
	if (
		plan.slotCount !== saved.length + 3 ||
		plan.points.length !== 2 ||
		plan.points.some((point) => point.registers.join(",") !== expected)
	)
		throw new Error(`wrong scalar/heap suspension transport at ${length}`);
}

console.log("native-root-planner PASS");
