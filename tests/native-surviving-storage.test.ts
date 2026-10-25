import { describe, expect, it } from "vitest";
import { COMPILER_VALUE_KIND_NUMBER } from "../src/compiler/shared/compiler-value-kinds.ts";
import {
	lowerNativeFunctionStorage,
	validateNativeStorage,
} from "../src/compiler/target/lower-native-storage.ts";
import { createConservativeNativePlan } from "../src/compiler/target/program-image.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";
import type {
	BytecodeFunction,
	BytecodeInstruction,
} from "../src/compiler/target/runtime-image.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

let template: BytecodeFunction | undefined;
const strings = [
	[118, 97, 108, 117, 101],
	[104, 101, 97, 112],
];

function fixture(
	instructions: Array<BytecodeInstruction>,
	overrides: Partial<BytecodeFunction> = {},
) {
	template ??= inspectStaticValueFunction(
		"function seed(value){return value;}globalThis.seed=seed;",
		"seed",
	).fn;
	const body = {
		...template,
		registerCount: 6,
		propertyIcCount: 1,
		positions: instructions.map(() => 0),
		instructions,
		...overrides,
	};
	const native = createConservativeNativePlan([body], strings).functions[0]!;
	return {
		...native,
		storageValues: Array.from({ length: body.registerCount }, (_, value) => value),
	};
}

function joinedWriter(fixed: boolean, heap: boolean) {
	const native = fixture([
		...(fixed
			? [{ opcode: "CREATE_BOOLEAN" as const, dst: 2, value: true }]
			: [{ opcode: "MOVE" as const, dst: 2, src: 0 }]),
		{ opcode: "JUMP_IF", cond: 2, targetIp: 4 },
		heap
			? { opcode: "CREATE_NUMBER", dst: 3, value: 7 }
			: { opcode: "CREATE_STRING", dst: 3, stringIndex: 1 },
		{ opcode: "JUMP", targetIp: 5 },
		heap
			? { opcode: "LOAD_PROPERTY_STATIC", dst: 3, object: 0, stringIndex: 0, icIndex: 0 }
			: { opcode: "CREATE_NUMBER", dst: 3, value: 7 },
		{ opcode: "RETURN", value: 3 },
	]);
	return lowerNativeFunctionStorage(native, new Map(), strings);
}

describe("surviving native storage", () => {
	it("rematerializes the sole surviving writer while keeping a dead alias out of the plan", () => {
		const native = joinedWriter(true, false);
		expect(native.storage!.controlFlow?.unreachableIps).toEqual([2, 3]);
		expect(native.storage!.rematerializedConstantIps).toContain(4);
		expect(native.storage!.rematerializedConstantIps).not.toContain(2);
		expect(native.storage!.definitionInitializedRegisters).toContain(3);
		expect(() => validateNativeStorage(native, new Map(), strings)).not.toThrow();
		const source = emitCompiledFunction(native, 0, "", false)!.source;
		expect(source).toMatch(/^#define r3 /m);
		expect(source).not.toContain("r3 = MAL_VALUE_UNDEFINED;");
	});

	it("retains both writers and default storage for an unknown condition", () => {
		const native = joinedWriter(false, false);
		expect(native.storage!.controlFlow).toBeUndefined();
		expect(native.storage!.rematerializedConstantIps).not.toContain(2);
		expect(native.storage!.rematerializedConstantIps).not.toContain(4);
		expect(native.storage!.unusedRegisters).not.toContain(3);
	});

	it("does not borrow a dead Number result proof for a live heap writer", () => {
		const original = joinedWriter(true, true);
		const native = lowerNativeFunctionStorage(
			{
				...original,
				facts: original.body.instructions.map((_, ip) =>
					ip === 2
						? {
								registers: [3],
								inputOffset: 1,
								inputKindMasks: [],
								resultKindMasks: [COMPILER_VALUE_KIND_NUMBER],
								effectMask: 0,
							}
						: undefined,
				),
			},
			new Map(),
			strings,
		);
		expect(native.storage!.rematerializedConstantIps).not.toContain(2);
		expect(native.storage!.rootRegisters).toContain(3);
		expect(native.storage!.unusedRegisters).not.toContain(3);
		expect(() => validateNativeStorage(native, new Map(), strings)).not.toThrow();
	});

	it("keeps defaults needed by an exceptional entry that bypasses the ordinary definition", () => {
		const native = lowerNativeFunctionStorage(
			fixture(
				[
					{ opcode: "CREATE_BOOLEAN", dst: 2, value: true },
					{ opcode: "JUMP_IF", cond: 2, targetIp: 4 },
					{ opcode: "CREATE_NUMBER", dst: 3, value: 8 },
					{ opcode: "JUMP", targetIp: 5 },
					{ opcode: "CREATE_NUMBER", dst: 3, value: 7 },
					{ opcode: "RETURN", value: 3 },
					{ opcode: "RETURN", value: 3 },
				],
				{ handlers: [{ startIp: 1, endIp: 5, handlerIp: 6 }] },
			),
			new Map(),
			strings,
		);
		expect(native.storage!.controlFlow?.unreachableIps).toContain(2);
		expect(native.storage!.definitionInitializedRegisters).not.toContain(3);
		expect(native.storage!.rematerializedConstantIps).not.toContain(4);
	});

	it("rejects an omitted local that survives as an operand or a GC root", () => {
		const native = joinedWriter(true, true);
		expect(() =>
			validateNativeStorage(
				{
					...native,
					storage: { ...native.storage!, unusedRegisters: [3] },
				},
				new Map(),
				strings,
			),
		).toThrow(/invalid or stale storage plan/);
	});

	it("retains resume-dispatch outputs when an ordinary branch cannot reach the yield", () => {
		const native = lowerNativeFunctionStorage(
			fixture(
				[
					{ opcode: "CREATE_BOOLEAN", dst: 2, value: false },
					{ opcode: "JUMP_IF", cond: 2, targetIp: 3 },
					{ opcode: "RETURN", value: 0 },
					{ opcode: "YIELD", yieldedSrc: 0, valueDst: 3, modeDst: 4 },
					{ opcode: "RETURN", value: 0 },
				],
				{ isGenerator: true },
			),
			new Map(),
			strings,
		);
		expect(native.storage!.controlFlow?.unreachableIps).toContain(3);
		expect(
			native.storage!.suspension!.points.some((point) => point.instructionIp === 3),
		).toBe(true);
		expect(native.storage!.unusedRegisters).not.toContain(3);
		expect(native.storage!.unusedRegisters).not.toContain(4);
		expect(() => validateNativeStorage(native, new Map(), strings)).not.toThrow();
	});
});
