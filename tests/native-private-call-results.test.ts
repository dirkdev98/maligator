import { describe, expect, it } from "vitest";
import type { NativeCallTransportPlan } from "../src/compiler/target/lower-native-calls.ts";
import {
	nativePrivateCallResultIps,
	nativePrivateRootRegisters,
	nativeRootedOutputRegisters,
} from "../src/compiler/target/lower-native-root-publication.ts";
import { createConservativeNativePlan } from "../src/compiler/target/program-image.ts";
import type { NativeInstructionPlan } from "../src/compiler/target/program-image.ts";
import type {
	BytecodeFunction,
	BytecodeInstruction,
} from "../src/compiler/target/runtime-image.ts";
import { testPropertyCacheCount } from "./helpers/program-image.ts";
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
		propertyIcCount: testPropertyCacheCount(instructions),
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

const transport = {
	instructionIp: 1,
	targets: [
		{
			functionIndex: 0,
			entryId: 0,
			arguments: [],
			resultRepresentation: "boxed",
			result: "identity",
			fields: [],
		},
	],
} satisfies NativeCallTransportPlan;
const direct = {
	kind: "call",
	directFunctionIndex: 0,
	directEntryId: 0,
} satisfies NativeInstructionPlan;

describe("ordinary CALL final-output eligibility", () => {
	it("shares only unplanned safepoint CALL outputs with the emitter contract", () => {
		const body = fn([
			load,
			call,
			call,
			call,
			call,
			{
				opcode: "CREATE_OBJECT_SHAPED",
				dst: 3,
				count: 0,
				keyStringIndices: [],
				valueRegisters: [],
				shapeCacheIndex: 0,
			},
			call,
		]);
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
			fieldCalls: [{ allocationIp: 5, callIp: 6, entries: [] }],
		};
		const privateCalls = nativePrivateCallResultIps(body, plan);
		expect([...privateCalls]).toEqual([1]);
		for (const ip of [1, 2, 3, 4, 6]) {
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

	it.each([
		["exact", direct],
		["guarded", { kind: "call", guardedFunctionIndices: [0], directEntryId: 0 }],
	] satisfies Array<[string, NativeInstructionPlan]>)(
		"keeps the %s transported final result private while preserving input storage",
		(_, selected) => {
			const body = fn([load, call]);
			const original = createConservativeNativePlan([body]).functions[0]!;
			const native = {
				...original,
				storageValues: [0, 1, 2, 3],
				instructions: [undefined, selected],
			};
			const calls = nativePrivateCallResultIps(body, native, [transport]);
			expect([...calls]).toEqual([1]);
			const privateRegisters = nativePrivateRootRegisters(
				body,
				native,
				new Set([0, 1, 2]),
				calls,
			);
			expect(privateRegisters.has(call.dst)).toBe(true);
			expect(privateRegisters.has(call.callee)).toBe(false);
			expect(privateRegisters.has(call.thisValue)).toBe(false);
		},
	);

	it("retains a specialized destination that also supplies a call input", () => {
		const alias = { ...call, callee: call.dst };
		const body = fn([load, alias]);
		const original = createConservativeNativePlan([body]).functions[0]!;
		const native = {
			...original,
			storageValues: [0, 1, 2, 3],
			instructions: [undefined, direct],
		};
		const calls = nativePrivateCallResultIps(body, native, [transport]);
		expect(calls.has(1)).toBe(true);
		expect(nativePrivateRootRegisters(body, native, new Set([2]), calls).has(2)).toBe(
			false,
		);
	});

	it.each([
		["Function.call bridge", { ...direct, directFunctionCall: true }],
		[
			"numeric sort",
			{
				...direct,
				numericSortCallback: { operation: "sort", functionIndex: 0, entryId: 0 },
			},
		],
		[
			"builtin",
			{
				...direct,
				guardedBuiltinCall: {
					operation: "Math.abs",
					guard: { dependencies: [], obligations: ["fallback"] },
				},
			},
		],
		["collection", { ...direct, exactCollectionReceiver: "Map" }],
	] satisfies Array<[string, NativeInstructionPlan]>)(
		"retains the %s output contract",
		(_, selected) => {
			const body = fn([load, call]);
			const native = {
				...createConservativeNativePlan([body]).functions[0]!,
				instructions: [undefined, selected],
			};
			expect([...nativePrivateCallResultIps(body, native, [transport])]).toEqual([]);
		},
	);

	it("requires a selected boxed transport and excludes virtual field materialization", () => {
		const body = fn([load, call]);
		const native = {
			...createConservativeNativePlan([body]).functions[0]!,
			instructions: [undefined, direct],
		};
		for (const transports of [
			[],
			[{ ...transport, targets: [] }],
			[
				{
					...transport,
					targets: transport.targets.map((target) => ({ ...target, fields: [0] })),
				},
			],
		])
			expect([...nativePrivateCallResultIps(body, native, transports)]).toEqual([]);
		expect([
			...nativePrivateCallResultIps(
				body,
				{ ...native, registerRepresentations: ["boxed", "boxed", "number", "boxed"] },
				[transport],
			),
		]).toEqual([]);
		for (const fieldCalls of [
			[{ allocationIp: 0, callIp: 1, entries: [] }],
			[{ allocationIp: 0, callIp: 2, entries: [] }],
		])
			expect([
				...nativePrivateCallResultIps(body, { ...native, fieldCalls }, [transport]),
			]).toEqual([]);
	});
});
