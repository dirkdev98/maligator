import { describe, expect, it } from "vitest";
import { lowerNativeFunctionStorage } from "../src/compiler/target/lower-native-storage.ts";
import { createConservativeNativePlan } from "../src/compiler/target/program-image.ts";
import type {
	NativeDirectEntryPlan,
	NativeFunctionPlan,
	VmRegisterRepresentation,
} from "../src/compiler/target/program-image.ts";
import {
	directCompiledEntryKey,
	emitCompiledFunction,
} from "../src/compiler/target/render-native-c.ts";
import type { BytecodeFunction } from "../src/compiler/target/runtime-image.ts";

const fn: BytecodeFunction = {
	nameStringIndex: -1,
	isGenerator: false,
	isAsync: false,
	parameterCount: 2,
	mappedArguments: false,
	mappedArgumentSlots: [],
	length: 2,
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
	propertyIcCount: 0,
	literalShapeCount: 0,
	handlers: [],
	fileIndex: -1,
	positions: [],
	instructions: [
		{
			opcode: "CALL",
			dst: 2,
			callee: 0,
			thisValue: -1,
			argumentCount: 1,
			arguments: [1],
		},
		{ opcode: "RETURN", value: 2 },
	],
};

const targetEntry: NativeDirectEntryPlan = {
	id: 0,
	parameterRepresentations: ["number"],
	resultRepresentation: "number",
	registerRepresentations: ["number"],
	gc: { safepoints: [] },
};

function emit(
	available = true,
	guarded = false,
	result: VmRegisterRepresentation = guarded ? "boxed" : "number",
	targetResult: VmRegisterRepresentation = "number",
) {
	const selectedTarget = { ...targetEntry, resultRepresentation: targetResult };
	const base = createConservativeNativePlan([fn]).functions[0]!;
	const numeric: NativeDirectEntryPlan = {
		id: 0,
		parameterRepresentations: ["boxed", "number"],
		resultRepresentation: result,
		registerRepresentations: ["boxed", "number", result],
		callOverrides: [
			{
				instructionIp: 0,
				functionIndex: 1,
				entryId: 0,
				...(guarded ? { guarded: true as const } : {}),
			},
		],
		gc: {
			safepoints: base.gc.safepoints.map((point) => ({
				...point,
				rootRegisters: point.rootRegisters.filter(
					(register) => register === 0 || (result === "boxed" && register === 2),
				),
				incomingRootRegisters: point.incomingRootRegisters.filter(
					(register) => register === 0 || (result === "boxed" && register === 2),
				),
				outgoingRootRegisters: point.outgoingRootRegisters.filter(
					(register) => register === 0 || (result === "boxed" && register === 2),
				),
			})),
		},
	};
	const native: NativeFunctionPlan = {
		...base,
		storageValues: [0, 1, 2],
		instructions: [{ kind: "call", directFunctionIndex: 1 }, undefined],
		directEntries: [
			numeric,
			{
				id: 1,
				parameterRepresentations: ["boxed", "boxed"],
				resultRepresentation: "boxed",
				registerRepresentations: base.registerRepresentations,
				gc: base.gc,
			},
		],
	};
	const emitted = emitCompiledFunction(
		lowerNativeFunctionStorage(
			native,
			new Map([[directCompiledEntryKey(1, 0), selectedTarget]]),
		),
		0,
		"",
		false,
		"static",
		new Set([1]),
		[],
		new Map(available ? [[directCompiledEntryKey(1, 0), selectedTarget]] : []),
		false,
		new Set([1]),
	)!;
	expect(emitted).not.toBeNull();
	expect(native.instructions[0]).toEqual({
		kind: "call",
		directFunctionIndex: 1,
	});
	return emitted;
}

describe("native entry call overrides", () => {
	it("keeps scalar downstream calls local to the proven entry", () => {
		const emitted = emit();
		const numeric = emitted.directEntries[0]!.source;
		expect(numeric).toContain("mal_direct_1_0(vm, MAL_VALUE_UNDEFINED, r1,");
		expect(numeric).toContain("r2 = __direct_value_0;");
		expect(numeric).not.toContain("((MalValue[])");
		for (const source of [emitted.source, emitted.directEntries[1]!.source]) {
			expect(source).toContain("mal_compiled_1(vm,");
			expect(source).toContain("((MalValue[]){ r1 })");
			expect(source).not.toContain("mal_direct_1_0(");
			expect(source).not.toContain("mal_ops_number_as_f64(");
		}
	});

	it("constructs the generic argument bridge when the typed target is unavailable", () => {
		const source = emit(false).directEntries[0]!.source;
		expect(source).toContain("mal_compiled_1(vm,");
		expect(source).toContain("((MalValue[]){ mal_ops_number_value(r1) })");
		expect(source).not.toContain("mal_direct_1_0(");
	});

	it("retains identity checks and generic fallback for a guarded entry override", () => {
		const emitted = emit(true, true);
		const source = emitted.directEntries[0]!.source;
		expect(source).toContain("if (__guarded_index_0 == 1)");
		expect(source).toContain("mal_direct_1_0(vm, MAL_VALUE_UNDEFINED, r1,");
		expect(source).toContain("mal_vm_call_cached(vm,");
		expect(emitted.source).not.toContain("__guarded_index_0");
	});
	it.each([true, false])(
		"publishes the private guarded boxed result when typed availability is %s",
		(available) => {
			const source = emit(available, true, "boxed", "boxed").directEntries[0]!.source;
			expect(source).toContain("#define r2 (__private_r2)");
			expect(source).toMatch(/if \(mal_gc_poll\) \{[^}]*__gc_slots\[\d+\] = r2;/);
			expect(source).not.toContain("__private_r2 = __gc_slots[");
			expect(source).toContain("mal_vm_call_cached(vm,");
			if (available) expect(source).toContain("mal_direct_1_0(");
			else expect(source).toContain("mal_vm_call_exact_script_compiled_callback(");
		},
	);
	it.each([
		["number", "number", "__guarded_entry_value_0"],
		["int32", "int32", "__guarded_entry_value_0"],
		["boolean", "boolean", "__guarded_entry_value_0"],
		["number", "int32", "(f64) __guarded_entry_value_0"],
		["int32", "number", "mal_ops_number_to_i32(__guarded_entry_value_0)"],
	] as const)(
		"transports guarded %s destinations from %s results without a boxed completion",
		(result, targetResult, value) => {
			const source = emit(true, true, result, targetResult).directEntries[0]!.source;
			expect(source).toContain(`r2 = ${value};`);
			expect(source).not.toContain(".value = mal_");
			expect(source).toContain("mal_vm_call_cached(vm,");
			expect(source).toContain("mal_vm_realm_switch_to(vm, __entry_realm);");
		},
	);
	it("uses defined Number-to-int32 conversion for an exact typed result", () => {
		const source = emit(true, false, "int32").directEntries[0]!.source;
		expect(source).toContain("r2 = mal_ops_number_to_i32(__direct_value_0);");
	});
});
