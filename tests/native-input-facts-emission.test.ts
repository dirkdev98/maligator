import { describe, expect, it } from "vitest";
import {
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_OBJECT,
	COMPILER_VALUE_KIND_STRING,
	COMPILER_VALUE_KIND_SYMBOL,
	COMPILER_VALUE_KIND_TOP,
} from "../src/compiler/shared/compiler-value-kinds.ts";
import type { InstructionFacts } from "../src/compiler/shared/instruction-facts.ts";
import { lowerNativeFunctionStorage } from "../src/compiler/target/lower-native-storage.ts";
import { createConservativeNativePlan } from "../src/compiler/target/program-image.ts";
import type { VmRegisterRepresentation } from "../src/compiler/target/program-image.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";
import type {
	BytecodeFunction,
	BytecodeInstruction,
} from "../src/compiler/target/runtime-image.ts";
import { inputFactsFixture } from "./helpers/native-input-facts.ts";

// Only the function's metadata is reused; building the whole fixture costs ~90 ms.
let baseFunction: BytecodeFunction | undefined;

// An entry closure needs the owned environment at once, so it is allocated eagerly.
const createsClosure: BytecodeInstruction = {
	opcode: "CREATE_FUNCTION",
	dst: 1,
	functionIndex: 0,
};

function emitInputContract(
	instructions: Array<BytecodeInstruction>,
	representations: Array<VmRegisterRepresentation>,
	options: Partial<BytecodeFunction> = {},
	facts?: ReadonlyArray<InstructionFacts | undefined>,
): string {
	const fn: BytecodeFunction = {
		...(baseFunction ??= inputFactsFixture().image.runtime.functions[0]!),
		...options,
		registerCount: representations.length,
		instructions,
	};
	const plan = createConservativeNativePlan([fn]).functions[0]!;
	const emitted = emitCompiledFunction(
		{
			...plan,
			facts,
			registerRepresentations: representations,
			gc: {
				safepoints: plan.gc.safepoints.map((point) => ({
					...point,
					rootRegisters: point.rootRegisters.filter(
						(register) =>
							representations[register] === "boxed" ||
							representations[register] === "string",
					),
					incomingRootRegisters: point.incomingRootRegisters.filter(
						(register) =>
							representations[register] === "boxed" ||
							representations[register] === "string",
					),
					outgoingRootRegisters: point.outgoingRootRegisters.filter(
						(register) =>
							representations[register] === "boxed" ||
							representations[register] === "string",
					),
				})),
			},
		},
		0,
		"",
		false,
	);
	expect(emitted).not.toBeNull();
	return emitted!.source;
}

describe("local native input admission", () => {
	it("uses owned capture slots only while the activation environment is stable", () => {
		const instructions: Array<BytecodeInstruction> = [
			createsClosure,
			{ opcode: "CREATE_NUMBER", dst: 0, value: 7 },
			{ opcode: "STORE_CAPTURED", src: 0, ownerFunctionIndex: 0, index: 0 },
			{ opcode: "LOAD_CAPTURED", dst: 0, ownerFunctionIndex: 0, index: 0 },
			{ opcode: "RETURN", value: 0 },
		];
		const owned = emitInputContract(instructions, ["boxed", "boxed"], {
			capturedCount: 1,
		});
		expect(owned).not.toContain("mal_vm_load_captured(");
		expect(owned).not.toContain("mal_vm_store_captured(");
		expect(owned).toMatch(
			/mal_gc_write_barrier\(env->slots\[0\]\);[\s\S]*env->slots\[0\] = [^;]+;[\s\S]*mal_gc_card\(&env->header,/,
		);
		for (const rebinding of [
			{ opcode: "ENV_PUSH", scopeId: -2, slotCount: 1 },
			{ opcode: "ENV_COPY", scopeId: -2, slotCount: 1 },
			{ opcode: "ENV_POP" },
			{ opcode: "WITH_ENTER", object: 0 },
			{ opcode: "WITH_EXIT" },
		] satisfies Array<BytecodeInstruction>) {
			const fallback = emitInputContract(
				[rebinding, ...instructions],
				["boxed", "boxed"],
				{
					capturedCount: 1,
				},
			);
			expect(fallback, rebinding.opcode).toContain("mal_vm_load_captured(");
			expect(fallback, rebinding.opcode).toContain("mal_vm_store_captured(");
		}
	});

	it("omits only the generational card for scalar captured stores", () => {
		const stores: Array<{
			create: BytecodeInstruction;
			representation: VmRegisterRepresentation;
		}> = [
			{ create: { opcode: "CREATE_NUMBER", dst: 0, value: 7 }, representation: "int32" },
			{ create: { opcode: "CREATE_F64", dst: 0, value: 1.5 }, representation: "number" },
			{
				create: { opcode: "CREATE_BOOLEAN", dst: 0, value: true },
				representation: "boolean",
			},
		];
		for (const { create, representation } of stores) {
			const instructions: Array<BytecodeInstruction> = [
				createsClosure,
				create,
				{ opcode: "STORE_CAPTURED", src: 0, ownerFunctionIndex: 0, index: 0 },
				{ opcode: "RETURN", value: 0 },
			];
			const owned = emitInputContract(instructions, [representation, "boxed"], {
				capturedCount: 1,
			});
			expect(owned).toContain("mal_gc_write_barrier(env->slots[0]);");
			expect(owned).toContain("env->slots[0] = ");
			expect(owned).not.toContain("mal_gc_card(&env->header,");
			const rebound = emitInputContract(
				[{ opcode: "ENV_PUSH", scopeId: -2, slotCount: 1 }, ...instructions],
				[representation, "boxed"],
				{ capturedCount: 1 },
			);
			expect(rebound).toContain("mal_vm_store_captured_non_heap(");
		}
		const pointer = emitInputContract(
			[
				createsClosure,
				{ opcode: "CREATE_STRING", dst: 0, stringIndex: 0 },
				{ opcode: "STORE_CAPTURED", src: 0, ownerFunctionIndex: 0, index: 0 },
				{ opcode: "RETURN", value: 0 },
			],
			["string", "boxed"],
			{ capturedCount: 1 },
		);
		expect(pointer).toContain("mal_gc_card(&env->header,");
	});

	it("keeps a canonical string key's nullish check on the failing branch", () => {
		const instructions: Array<BytecodeInstruction> = [
			{ opcode: "CREATE_F64", dst: 0, value: 0 },
			{ opcode: "CREATE_STRING", dst: 1, stringIndex: 0 },
			{ opcode: "TO_PROPERTY_KEY", dst: 2, object: 0, key: 1 },
			{ opcode: "RETURN", value: 2 },
		];
		const proven = emitInputContract(instructions, ["number", "string", "boxed"]);
		expect(proven).not.toContain("mal_vm_op_to_property_key(");
		const guarded = emitInputContract(instructions, ["boxed", "string", "boxed"]);
		expect(guarded).toMatch(
			/if \(mal_value_is_nil\([^\n]+\)\) \{\s+[^\n]*mal_vm_op_to_property_key\([^\n]+\);\s+if \(MAL_THREW\(\)\)/,
		);
		const coercive = emitInputContract(instructions, ["boxed", "boxed", "boxed"]);
		expect(coercive).toContain("mal_vm_op_to_property_key(");
		expect(coercive).not.toContain("mal_value_is_nil(");
	});

	it("uses boxed key facts while retaining a possible nullish-base failure", () => {
		const instructions: Array<BytecodeInstruction> = [
			{ opcode: "CREATE_F64", dst: 0, value: 0 },
			{ opcode: "CREATE_STRING", dst: 1, stringIndex: 0 },
			{ opcode: "TO_PROPERTY_KEY", dst: 2, object: 0, key: 1 },
			{ opcode: "RETURN", value: 2 },
		];
		for (const key of [
			COMPILER_VALUE_KIND_STRING,
			COMPILER_VALUE_KIND_STRING | COMPILER_VALUE_KIND_SYMBOL,
		]) {
			for (const base of [COMPILER_VALUE_KIND_NUMBER, COMPILER_VALUE_KIND_TOP]) {
				const emitted = emitInputContract(instructions, ["boxed", "boxed", "boxed"], {}, [
					undefined,
					undefined,
					{
						registers: [2, 0, 1],
						inputOffset: 1,
						inputKindMasks: [base, key],
						resultKindMasks: [key],
					},
				]);
				expect(emitted.includes("mal_vm_op_to_property_key(")).toBe(
					base === COMPILER_VALUE_KIND_TOP,
				);
				expect(emitted.includes("if (mal_value_is_nil(")).toBe(
					base === COMPILER_VALUE_KIND_TOP,
				);
			}
		}
	});
	it("decodes a proven boxed Number before the indexed definition helper", () => {
		const emitted = emitInputContract(
			[
				{ opcode: "CREATE_ARRAY", dst: 0, length: 1 },
				{ opcode: "CREATE_NUMBER", dst: 1, value: 0 },
				{ opcode: "CREATE_NUMBER", dst: 2, value: 7 },
				{
					opcode: "DEFINE_PROPERTY",
					object: 0,
					key: 1,
					value: 2,
					enumerable: true,
					writable: true,
					configurable: true,
				},
				{ opcode: "RETURN", value: 0 },
			],
			["boxed", "boxed", "boxed"],
			{},
			[
				undefined,
				undefined,
				undefined,
				{
					registers: [0, 1, 2],
					inputOffset: 0,
					inputKindMasks: [
						COMPILER_VALUE_KIND_OBJECT,
						COMPILER_VALUE_KIND_NUMBER,
						COMPILER_VALUE_KIND_NUMBER,
					],
					resultKindMasks: [],
				},
			],
		);
		expect(emitted).toContain("mal_ops_number_as_f64(r1)");
		expect(emitted).not.toContain("mal_ops_is_number(r1)");
	});
	it("folds primitive guards and reads string length without borrowing boxed facts", () => {
		const instructions: Array<BytecodeInstruction> = [
			{ opcode: "CREATE_STRING", dst: 0, stringIndex: 0 },
			{ opcode: "REQUIRE_COERCIBLE", src: 0 },
			{ opcode: "IS_EMPTY", dst: 1, src: 0 },
			{ opcode: "GUARD_FUNCTION_INDEX", dst: 1, callee: 0, functionIndex: 0 },
			{ opcode: "UNARY", dst: 1, src: 0, operator: "!" },
			{ opcode: "RETURN", value: 1 },
		];
		const primitive = emitInputContract(instructions, ["string", "boolean"]);
		const boxed = emitInputContract(instructions, ["boxed", "boolean"]);
		const coroutine = emitInputContract(
			[{ opcode: "GENERATOR_START" }, ...instructions],
			["boxed", "boxed"],
			{ isGenerator: true },
		);
		for (const helper of [
			"mal_vm_op_require_coercible(",
			"mal_value_is_empty(",
			"mal_vm_callee_has_index(",
			"mal_value_is_truthy(",
		]) {
			expect(primitive).not.toContain(helper);
			expect(boxed).toContain(helper);
			expect(coroutine).toContain(helper);
		}
		expect(primitive).toContain("mal_string_length(");
	});
});

function mathCallSource(stable: boolean, binary: boolean): string {
	const { image } = inputFactsFixture();
	const fn: BytecodeFunction = {
		...image.runtime.functions[0]!,
		registerCount: 5,
		instructions: [
			{ opcode: "CREATE_F64", dst: 0, value: 1.5 },
			{ opcode: "CREATE_F64", dst: 1, value: -0 },
			{ opcode: "CREATE_UNDEFINED", dst: 2 },
			{ opcode: "CREATE_UNDEFINED", dst: 3 },
			{
				opcode: "CALL",
				dst: 4,
				callee: 2,
				thisValue: 3,
				arguments: binary ? [0, 1] : [0],
				argumentCount: binary ? 2 : 1,
			},
			{ opcode: "RETURN", value: 4 },
		],
	};
	const plan = createConservativeNativePlan([fn]).functions[0]!;
	const instructions = [...plan.instructions];
	instructions[4] = {
		kind: "call",
		guardedBuiltinCall: {
			operation: binary ? "Math.max" : "Math.floor",
			guard: {
				dependencies: stable
					? [{ kind: "world", fact: "primordials.locked" }]
					: [{ kind: "epoch", family: "watched-methods" }],
				obligations: ["fallback"],
			},
		},
	};
	const emitted = emitCompiledFunction(
		lowerNativeFunctionStorage({
			...plan,
			registerRepresentations: ["number", "number", "boxed", "boxed", "boxed"],
			instructions,
			gc: {
				safepoints: plan.gc.safepoints.map((point) => ({
					...point,
					rootRegisters: point.rootRegisters.filter((register) => register > 1),
					incomingRootRegisters: point.incomingRootRegisters.filter(
						(register) => register > 1,
					),
					outgoingRootRegisters: point.outgoingRootRegisters.filter(
						(register) => register > 1,
					),
				})),
			},
		}),
		0,
		"",
		false,
	);
	expect(emitted).not.toBeNull();
	return emitted!.source;
}

describe("boxed Math result identity admission", () => {
	it.each([false, true])(
		"keeps loaded-callee guards in locked and mutable worlds (binary: %s)",
		(binary) => {
			const guarded = mathCallSource(false, binary),
				stable = mathCallSource(true, binary);
			expect(guarded).toContain(
				binary
					? "mal_builtin_math_binary_callee_matches"
					: "mal_builtin_math_unary_callee_matches",
			);
			expect(guarded).toContain("mal_vm_call_cached");
			expect(stable).toContain(
				binary
					? "mal_builtin_math_binary_callee_matches"
					: "mal_builtin_math_unary_callee_matches",
			);
			expect(stable).toContain("mal_vm_call_cached");
			expect(stable).toContain("mal_gc_safepoint");
		},
	);
});
