import { describe, expect, it } from "vitest";
import {
	nativeEntryStableRootRegisters,
	nativePrivateRootRegisters,
} from "../src/compiler/target/lower-native-root-publication.ts";
import { createConservativeNativePlan } from "../src/compiler/target/program-image.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";
import { vmInstructionWriteRegisters } from "../src/compiler/target/runtime-image.ts";
import type { BytecodeFunction } from "../src/compiler/target/runtime-image.ts";

function argumentCacheReceiver(): BytecodeFunction {
	return {
		nameStringIndex: -1,
		isGenerator: false,
		isAsync: false,
		parameterCount: 1,
		mappedArguments: false,
		mappedArgumentSlots: [],
		length: 1,
		registerCount: 3,
		capturedCount: 0,
		strict: true,
		needsArguments: true,
		argumentSnapshotCount: 0,
		argumentSnapshotPlan: [],
		isDerivedConstructor: false,
		isClassConstructor: false,
		constructorSlotReserve: 0,
		hasPrototype: false,
		literalShapeCount: 0,
		instructions: [
			{ opcode: "LOAD_STATIC_ARGUMENT", dst: 1, direct: -1, fallback: 0, index: 1 },
			{ opcode: "LOAD_PROPERTY_STATIC", object: 0, dst: 2, stringIndex: 0, icIndex: 0 },
			{ opcode: "RETURN", value: 2 },
		],
		handlers: [],
		fileIndex: -1,
		positions: [],
	};
}

describe("native static-argument fallback storage", () => {
	it("reports both the loaded value and the conditional cache replacement as definitions", () => {
		const fn = argumentCacheReceiver();
		expect(vmInstructionWriteRegisters(fn.instructions[0]!)).toEqual([1, 0]);
	});

	it("keeps a fallback cache rooted even when that physical register is a property receiver", () => {
		const fn = argumentCacheReceiver();
		const native = createConservativeNativePlan([fn]).functions[0]!;
		expect(nativePrivateRootRegisters(fn, native, new Set([0, 1, 2])).has(0)).toBe(false);
	});

	it("does not classify an entry parameter overwritten by fallback materialization as stable", () => {
		const fn = argumentCacheReceiver();
		expect([...nativeEntryStableRootRegisters(fn, new Set([0]))]).toEqual([]);
	});

	it("uses shadow storage across materialization and the following property helper", () => {
		const fn = argumentCacheReceiver();
		const native = createConservativeNativePlan([fn]).functions[0]!;
		const source = emitCompiledFunction(fn, native, 0, "", false)!.source;
		expect(source).toContain("r0 = mal_create_arguments_object(");
		expect(source).toContain("mal_vm_op_load_property(vm, r0,");
		expect(source).toMatch(/#define r0 \(__gc_slots\[\d+\]\)/);
		expect(source).not.toContain("#define r0 (__private_r0)");
	});
});
