import { describe, expect, it } from "vitest";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
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

const strings = ["", "ready", "other", "wide"].map((s) =>
	[...s].map((c) => c.charCodeAt(0)),
);
let template: BytecodeFunction | undefined;
function fixture(
	instructions: Array<BytecodeInstruction>,
	overrides: Partial<BytecodeFunction> = {},
) {
	template ??= inspectStaticValueFunction(
		"function seed(a,b){return a;}globalThis.seed=seed;",
		"seed",
	).fn;
	const body = {
		...template,
		registerCount: 8,
		instructions,
		positions: instructions.map(() => 0),
		...overrides,
	};
	const native = createConservativeNativePlan([body], strings).functions[0]!;
	return lowerNativeFunctionStorage(
		{ ...native, storageValues: Array.from({ length: 8 }, (_, i) => i) },
		new Map(),
		strings,
	);
}

function joined(alternative: number) {
	return fixture([
		{ opcode: "JUMP_IF", cond: 1, targetIp: 3 },
		{ opcode: "CREATE_STRING", dst: 2, stringIndex: 1 },
		{ opcode: "JUMP", targetIp: 5 },
		{ opcode: "CREATE_STRING", dst: 2, stringIndex: alternative },
		{ opcode: "JUMP", targetIp: 5 },
		{ opcode: "MOVE", dst: 3, src: 2 },
		{ opcode: "BINARY", dst: 4, left: 0, right: 3, operator: "===" },
		{ opcode: "RETURN", value: 4 },
	]);
}

describe("planned String comparison lengths", () => {
	it("joins equal UTF-16 lengths through different literals and a copy", () => {
		const native = joined(2);
		expect(native.storage!.stringComparisons).toEqual([
			{ instructionIp: 6, register: 3, length: 5, kind: "boxed" },
		]);
		expect(() => validateNativeStorage(native, new Map(), strings)).not.toThrow();
		const c = emitCompiledFunction(native, 0, "", false)!.source;
		expect(c).toContain("mal_ops_strict_equal_string_constant(");
		expect(c).not.toContain("mal_ops_strict_equal_boxed(");
	});
	it("retains general equality for different literal lengths", () => {
		const native = joined(3);
		expect(native.storage!.stringComparisons).toEqual([]);
		expect(emitCompiledFunction(native, 0, "", false)!.source).toContain(
			"mal_ops_strict_equal_boxed(",
		);
	});
	it("carries a successful String key conversion into a later equality", () => {
		const native = fixture([
			{ opcode: "CREATE_STRING", dst: 2, stringIndex: 1 },
			{ opcode: "TO_PROPERTY_KEY", dst: 3, object: 1, key: 2 },
			{ opcode: "BINARY", dst: 4, left: 0, right: 3, operator: "===" },
			{ opcode: "RETURN", value: 4 },
		]);
		expect(native.storage!.stringComparisons).toEqual([
			{ instructionIp: 2, register: 3, length: 5, kind: "boxed" },
		]);
		const emitted = emitCompiledFunction(native, 0, "", false)!.source;
		expect(emitted).toContain("mal_vm_op_to_property_key(");
		expect(emitted).toContain("mal_ops_strict_equal_string_constant(");
	});
	it("ignores a dead non-String writer after refining an edge", () => {
		const native = fixture([
			{ opcode: "CREATE_BOOLEAN", dst: 2, value: true },
			{ opcode: "JUMP_IF", cond: 2, targetIp: 4 },
			{ opcode: "CREATE_NUMBER", dst: 3, value: 7 },
			{ opcode: "JUMP", targetIp: 5 },
			{ opcode: "CREATE_STRING", dst: 3, stringIndex: 1 },
			{ opcode: "BINARY", dst: 4, left: 0, right: 3, operator: "!==" },
			{ opcode: "RETURN", value: 4 },
		]);
		expect(native.storage!.controlFlow?.unreachableIps).toContain(2);
		expect(native.storage!.stringComparisons).toEqual([
			{ instructionIp: 5, register: 3, length: 5, kind: "boxed" },
		]);
	});
	it("rejects a parameter whose literal assignment can be bypassed", () => {
		const native = fixture([
			{ opcode: "JUMP_IF", cond: 0, targetIp: 2 },
			{ opcode: "CREATE_STRING", dst: 1, stringIndex: 1 },
			{ opcode: "BINARY", dst: 2, left: 0, right: 1, operator: "===" },
			{ opcode: "RETURN", value: 2 },
		]);
		expect(native.storage!.stringComparisons).toEqual([]);
	});
	it("does not carry ordinary definitions across handler entry", () => {
		const native = fixture(
			[
				{ opcode: "CREATE_STRING", dst: 2, stringIndex: 1 },
				{ opcode: "JUMP", targetIp: 3 },
				{ opcode: "CATCH", dst: 3 },
				{ opcode: "BINARY", dst: 4, left: 0, right: 2, operator: "===" },
				{ opcode: "RETURN", value: 4 },
			],
			{ handlers: [{ startIp: 0, endIp: 2, handlerIp: 2 }] },
		);
		expect(native.storage!.stringComparisons).toEqual([]);
	});
	it("retains a loop-invariant length without requiring one physical writer", () => {
		const native = fixture([
			{ opcode: "CREATE_STRING", dst: 2, stringIndex: 1 },
			{ opcode: "BINARY", dst: 3, left: 0, right: 2, operator: "===" },
			{ opcode: "JUMP_IF", cond: 1, targetIp: 4 },
			{ opcode: "RETURN", value: 3 },
			{ opcode: "CREATE_STRING", dst: 2, stringIndex: 2 },
			{ opcode: "JUMP", targetIp: 1 },
		]);
		expect(native.storage!.stringComparisons).toContainEqual({
			instructionIp: 1,
			register: 2,
			length: 5,
			kind: "boxed",
		});
	});
	it("rejects forged lengths and preserves the decision through the artifact", () => {
		const out = inspectStaticValueFunction(
			"function target(value,flag){const text=flag?'ready':'other';return value===text;}globalThis.target=target;",
			"target",
		);
		const restored = deserializeCompilerArtifact(serializeCompilerArtifact(out.image));
		expect(
			restored.native.functions[out.native.functionIndex]!.storage!.stringComparisons,
		).toEqual(out.native.storage!.stringComparisons);
		const native = joined(2);
		expect(() =>
			validateNativeStorage(
				{
					...native,
					storage: {
						...native.storage!,
						stringComparisons: [
							{ instructionIp: 6, register: 3, length: 4, kind: "boxed" },
						],
					},
				},
				new Map(),
				strings,
			),
		).toThrow();
	});
	it("selects the String-only helper from semantic facts through boxed storage", () => {
		const out = inspectStaticValueFunction(
			"function target(value,flag){const text=String(value);const literal=flag?'ready':'other';return text===literal;}globalThis.target=target;",
			"target",
		);
		const native = lowerNativeFunctionStorage(
			{
				...out.native,
				registerRepresentations: out.native.registerRepresentations.map((rep) =>
					rep === "string" ? "boxed" : rep,
				),
			},
			new Map(),
			out.image.runtime.stringConstants,
		);
		expect(
			native.storage!.stringComparisons.some(
				(plan) => plan.kind === "strings" && plan.length === 5,
			),
		).toBe(true);
		expect(
			emitCompiledFunction(native, native.functionIndex, "", false)!.source,
		).toContain("mal_string_equals_constant_length(");
		const general = joined(2);
		expect(() =>
			validateNativeStorage(
				{
					...general,
					storage: {
						...general.storage!,
						stringComparisons: general.storage!.stringComparisons.map((plan) => ({
							...plan,
							kind: "strings",
						})),
					},
				},
				new Map(),
				strings,
			),
		).toThrow();
	});
});
