import { describe, expect, it } from "vitest";
import { nativeEntryStableRootRegisters } from "../src/compiler/target/lower-native-root-publication.ts";
import { createConservativeNativePlan } from "../src/compiler/target/program-image.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";
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
function emit(body: BytecodeFunction): string {
	const native = createConservativeNativePlan([body]).functions[0]!;
	return emitCompiledFunction(body, native, 0, "", false)!.source;
}
describe("entry-stable private roots", () => {
	it("recognizes unchanged private parameters, not locals or unpublished registers", () => {
		const body = fn([load, call, { opcode: "RETURN", value: 2 }]);
		expect([...nativeEntryStableRootRegisters(body, new Set([0, 1, 2]))]).toEqual([0]);
		expect([...nativeEntryStableRootRegisters(body, new Set([1, 2]))]).toEqual([]);
	});
	it("rejects physical register replacement and continuously rooted helper outputs", () => {
		for (const write of [
			{ opcode: "MOVE", src: 1, dst: 0 },
			{ ...call, dst: 0 },
		] as Array<BytecodeInstruction>) {
			expect([
				...nativeEntryStableRootRegisters(fn([load, write]), new Set([0])),
			]).toEqual([]);
		}
	});
	it("publishes an immutable private receiver at entry rather than at every miss", () => {
		const source = emit(fn([load, call, { opcode: "RETURN", value: 2 }]));
		expect(source).toContain("#define r0 (__private_r0)");
		expect(source.match(/__gc_slots\[\d+\] = r0;/g)).toHaveLength(1);
		expect(source).toContain("mal_vm_op_load_property_ic_static_miss");
	});
	it("keeps publication when a parameter register receives another heap value", () => {
		const source = emit(
			fn([
				load,
				{ opcode: "MOVE", src: 1, dst: 0 },
				load,
				call,
				{ opcode: "RETURN", value: 2 },
			]),
		);
		expect(source).toContain("#define r0 (__private_r0)");
		expect((source.match(/__gc_slots\[\d+\] = r0;/g) ?? []).length).toBeGreaterThan(1);
	});
});
