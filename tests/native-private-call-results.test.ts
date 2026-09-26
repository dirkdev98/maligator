import { describe, expect, it } from "vitest";
import {
	nativePrivateCallResultIps,
	nativeRootedOutputRegisters,
} from "../src/compiler/target/lower-native-root-publication.ts";
import { createConservativeNativePlan } from "../src/compiler/target/program-image.ts";
import type {
	BytecodeFunction,
	BytecodeInstruction,
} from "../src/compiler/target/runtime-image.ts";
function fn(instructions: Array<BytecodeInstruction>): BytecodeFunction {
	return {
		nameStringIndex: -1,
		isGenerator: false,
		isAsync: false,
		parameterCount: 1,
		mappedArguments: false,
		mappedArgumentSlots: [],
		length: 1,
		registerCount: 4,
		capturedCount: 0,
		strict: true,
		needsArguments: false,
		argumentSnapshotCount: 0,
		argumentSnapshotPlan: [],
		isDerivedConstructor: false,
		isClassConstructor: false,
		constructorSlotReserve: 0,
		hasPrototype: false,
		literalShapeCount: 0,
		instructions,
		handlers: [],
		fileIndex: -1,
		positions: [],
	};
}
const load: BytecodeInstruction = {
	opcode: "LOAD_PROPERTY_STATIC",
	object: 0,
	dst: 1,
	stringIndex: 0,
	icIndex: 0,
};
const call: BytecodeInstruction = {
	opcode: "CALL",
	dst: 2,
	callee: 1,
	thisValue: 0,
	argumentCount: 0,
	arguments: [],
};

describe("ordinary CALL final-output eligibility", () => {
	it("shares only unplanned safepoint CALL outputs with the emitter contract", () => {
		const body = fn([load, call, call, call, call, call]);
		const native = createConservativeNativePlan([body]).functions[0]!;
		const plan = {
			...native,
			instructions: body.instructions.map((_, ip) =>
				ip === 3 ? { kind: "call" as const } : undefined,
			),
			gc: {
				safepoints: native.gc.safepoints.filter((point) => point.instructionIp !== 2),
			},
			regionActions: [{ ip: 4, regionIndex: 0, role: "call" as const }],
			fieldCalls: [{ allocationIp: 0, callIp: 5, entries: [] }],
		};
		const privateCalls = nativePrivateCallResultIps(body, plan);
		expect([...privateCalls]).toEqual([1]);
		for (const ip of [1, 2, 3, 4, 5]) {
			expect(nativeRootedOutputRegisters(call, ip, privateCalls)).toEqual(
				ip === 1 ? [] : [call.dst],
			);
		}
	});
	it.each(["isAsync", "isGenerator"] as const)(
		"retains the resumable %s frame contract",
		(flag) => {
			const body = { ...fn([load, call]), [flag]: true };
			const native = createConservativeNativePlan([body]).functions[0]!;
			expect([...nativePrivateCallResultIps(body, native)]).toEqual([]);
		},
	);
});
