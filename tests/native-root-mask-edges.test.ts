import { describe, expect, it } from "vitest";
import { createConservativeNativePlan } from "../src/compiler/target/program-image.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";
import type { BytecodeFunction } from "../src/compiler/target/runtime-image.ts";
describe("native binary root-mask edges", () => {
	it("publishes the original union mask inside the generic coercing edge, not the numeric hit", () => {
		const fn: BytecodeFunction = {
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
			needsArguments: false,
			argumentSnapshotCount: 0,
			argumentSnapshotPlan: [],
			isDerivedConstructor: false,
			isClassConstructor: false,
			constructorSlotReserve: 0,
			hasPrototype: false,
			literalShapeCount: 0,
			instructions: [
				{ opcode: "LOAD_PROPERTY_STATIC", object: 0, dst: 1, stringIndex: 0, icIndex: 0 },
				{ opcode: "BINARY", dst: 2, left: 1, right: 0, operator: "+" },
				{ opcode: "RETURN", value: 2 },
			],
			handlers: [],
			fileIndex: -1,
			positions: [],
		};
		const native = createConservativeNativePlan([fn]).functions[0]!;
		const output = emitCompiledFunction(
			fn,
			{
				...native,
				gc: {
					safepoints: [
						{
							kind: "operation",
							instructionIp: 0,
							rootRegisters: [0, 1],
							incomingRootRegisters: [0],
							outgoingRootRegisters: [0, 1],
						},
						{
							kind: "operation",
							instructionIp: 1,
							rootRegisters: [0, 1, 2],
							incomingRootRegisters: [0, 1],
							outgoingRootRegisters: [2],
						},
					],
				},
			},
			0,
			"",
			false,
		)!.source;
		const miss = output.indexOf("mal_vm_op_load_property_ic_static_miss");
		const propertyEnd = output.indexOf("\n    }", miss);
		const guard = output.indexOf("if (mal_ops_is_number", propertyEnd);
		const call = output.indexOf("mal_vm_binary_op", guard);
		const fallback = output.lastIndexOf("} else {", call);
		expect(miss).toBeGreaterThan(0);
		expect(propertyEnd).toBeGreaterThan(miss);
		expect(guard).toBeGreaterThan(propertyEnd);
		expect(call).toBeGreaterThan(guard);
		expect(fallback).toBeGreaterThan(guard);
		expect(output.slice(propertyEnd, fallback)).not.toContain("MAL_ROOT_MASK(");
		expect(output.slice(fallback, call)).toContain("MAL_ROOT_MASK(0x0)");
		expect(output.slice(fallback, call)).toContain("__gc_slots[1] = r1");
	});
});
