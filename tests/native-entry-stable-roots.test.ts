import { describe, expect, it } from "vitest";
import {
	nativeEntryStableRootRegisters,
	nativePrivateRootRegisters,
} from "../src/compiler/target/lower-native-root-publication.ts";
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
	it("publishes a stable callee once without requiring a property-access nomination", () => {
		const invokeParameter: BytecodeInstruction = { ...call, callee: 0, thisValue: 1 };
		const body = fn([
			{ opcode: "CREATE_UNDEFINED", dst: 1 },
			invokeParameter,
			invokeParameter,
			{ opcode: "RETURN", value: 2 },
		]);
		const source = emit(body);
		expect(source).toContain("#define r0 (__private_r0)");
		expect(source.match(/__gc_slots\[\d+\] = r0;/g)).toHaveLength(1);
		expect(source.match(/mal_vm_call_cached\(/g)).toHaveLength(2);
	});
	it("republishes a no-property parameter after an ordinary call replaces its value", () => {
		const body = fn([
			{ opcode: "CREATE_UNDEFINED", dst: 1 },
			{ ...call, callee: 0, thisValue: 1, dst: 0 },
			{ ...call, callee: 0, thisValue: 1 },
			{ opcode: "RETURN", value: 2 },
		]);
		const source = emit(body);
		expect(source).toContain("#define r0 (__private_r0)");
		expect(nativeEntryStableRootRegisters(body, new Set([0])).has(0)).toBe(false);
		const publication = source.match(/__gc_slots\[\d+\] = r0;/)?.[0];
		expect(publication).toBeDefined();
		const assignment = source.indexOf("r0 = call_result_1.value;");
		const nextCall = source.indexOf("MalCompletion call_result_2");
		expect(assignment).toBeGreaterThan(0);
		expect(nextCall).toBeGreaterThan(assignment);
		const continuation = source.slice(assignment, nextCall);
		expect(continuation).toContain(
			`if (mal_gc_poll) { ${publication} mal_gc_safepoint(vm); }`,
		);
		expect(continuation.split("\n")).toContain(`    ${publication}`);
	});
	it("keeps a stable parameter in rooted storage when a specialized call uses it", () => {
		const body = fn([
			{ opcode: "CREATE_UNDEFINED", dst: 1 },
			{ ...call, callee: 0, thisValue: 1 },
			{ opcode: "RETURN", value: 2 },
		]);
		const native = createConservativeNativePlan([body]).functions[0]!;
		const frameRegisters = new Set(
			native.gc.safepoints.flatMap((point) => point.rootRegisters),
		);
		expect(nativePrivateRootRegisters(body, native, frameRegisters).has(0)).toBe(true);
		expect(
			nativePrivateRootRegisters(
				body,
				{ ...native, instructions: [undefined, { kind: "call" }, undefined] },
				frameRegisters,
			).has(0),
		).toBe(false);
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
