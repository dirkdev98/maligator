import { describe, expect, it } from "vitest";
import { createConservativeNativePlan } from "../src/compiler/target/program-image.ts";
import type { VmRegisterRepresentation } from "../src/compiler/target/program-image.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";
import type {
	BytecodeFunction,
	BytecodeInstruction,
} from "../src/compiler/target/runtime-image.ts";
import { inputFactsFixture } from "./helpers/native-input-facts.ts";

function emitInputContract(
	instructions: Array<BytecodeInstruction>,
	representations: Array<VmRegisterRepresentation>,
	options: Partial<BytecodeFunction> = {},
): string {
	const fn: BytecodeFunction = {
		...inputFactsFixture().image.runtime.functions[0]!,
		...options,
		registerCount: representations.length,
		instructions,
	};
	const plan = createConservativeNativePlan([fn]).functions[0]!;
	const emitted = emitCompiledFunction(
		fn,
		{
			...plan,
			registerRepresentations: representations,
			gc: {
				safepoints: plan.gc.safepoints.map((point) => ({
					...point,
					rootRegisters: point.rootRegisters.filter(
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
			{ opcode: "CREATE_NUMBER", dst: 0, value: 7 },
			{ opcode: "STORE_CAPTURED", src: 0, ownerFunctionIndex: 0, index: 0 },
			{ opcode: "LOAD_CAPTURED", dst: 0, ownerFunctionIndex: 0, index: 0 },
			{ opcode: "RETURN", value: 0 },
		];
		const owned = emitInputContract(instructions, ["boxed"], { capturedCount: 1 });
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
			const fallback = emitInputContract([rebinding, ...instructions], ["boxed"], {
				capturedCount: 1,
			});
			expect(fallback, rebinding.opcode).toContain("mal_vm_load_captured(");
			expect(fallback, rebinding.opcode).toContain("mal_vm_store_captured(");
		}
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
			/if \(mal_value_is_nil\([^\n]+\)\) \{\s+[^\n]*mal_vm_op_to_property_key\([^\n]+\);\s+if \(vm->completion.kind == MAL_COMPLETION_THROW\)/,
		);
		const coercive = emitInputContract(instructions, ["boxed", "boxed", "boxed"]);
		expect(coercive).toContain("mal_vm_op_to_property_key(");
		expect(coercive).not.toContain("mal_value_is_nil(");
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
			["string", "boolean"],
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
		fn,
		{
			...plan,
			registerRepresentations: ["number", "number", "boxed", "boxed", "boxed"],
			instructions,
			gc: {
				safepoints: plan.gc.safepoints.map((point) => ({
					...point,
					rootRegisters: point.rootRegisters.filter((register) => register > 1),
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

describe("boxed Math result identity admission", () => {
	it.each([false, true])(
		"requires stable identity before eliminating the runtime guard (binary: %s)",
		(binary) => {
			const guarded = mathCallSource(false, binary),
				stable = mathCallSource(true, binary);
			expect(guarded).toContain(
				binary ? "mal_builtin_math_binary_fast" : "mal_builtin_math_unary_fast",
			);
			expect(guarded).toContain("mal_vm_call_cached");
			expect(stable).not.toContain("mal_builtin_math_");
			expect(stable).not.toContain("mal_vm_call_cached");
			expect(stable).toContain("mal_gc_safepoint");
		},
	);
});
