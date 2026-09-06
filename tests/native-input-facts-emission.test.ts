import { describe, expect, it } from "vitest";
import { createConservativeNativePlan } from "../src/compiler/target/program-image.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";
import type { BytecodeFunction } from "../src/compiler/target/runtime-image.ts";
import { inputFactsFixture } from "./helpers/native-input-facts.ts";

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
