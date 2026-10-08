import { describe, expect, it } from "vitest";
import {
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_STRING,
} from "../src/compiler/shared/compiler-value-kinds.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { lowerNativeStorage } from "../src/compiler/target/lower-native-storage.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

describe("proven String comparisons in boxed storage", () => {
	it.each(["<", "<=", ">", ">=", "==", "!=", "===", "!=="])(
		"roundtrips and emits the exact String kernel for %s",
		(operator) => {
			const out = inspectStaticValueFunction(
				`function compute(left,right,gate){const a=String(left);const b=String(right);gate();return a ${operator} b;}globalThis.compute=compute;`,
				"compute",
				{ profile: true },
			);
			const ip = out.native.body.instructions.findIndex(
				(op) => op.opcode === "BINARY" && op.operator === operator,
			);
			const op = out.native.body.instructions[ip]!;
			if (op.opcode !== "BINARY") throw new Error("Missing comparison");
			expect(out.native.instructions[ip]).toEqual({
				kind: "exact-operator-input-kinds",
				inputKindMasks: [COMPILER_VALUE_KIND_STRING, COMPILER_VALUE_KIND_STRING],
			});
			const image = lowerNativeStorage({
				...out.image,
				native: {
					...out.image.native,
					functions: out.image.native.functions.map((fn) =>
						fn !== out.native
							? fn
							: {
									...fn,
									registerRepresentations: fn.registerRepresentations.map((rep, local) =>
										local === op.left || local === op.right || local === op.dst
											? "boxed"
											: rep,
									),
								},
					),
				},
			});
			const restored = deserializeCompilerArtifact(serializeCompilerArtifact(image));
			expect(restored).toEqual(image);
			const index = image.native.functions.indexOf(
				image.native.functions.find((fn) => fn.body === out.native.body)!,
			);
			const fn = restored.native.functions[index]!;
			expect(fn.storage!.rootRegisters).toEqual(
				expect.arrayContaining([op.left, op.right]),
			);
			const c = emitCompiledFunction(
				fn,
				index,
				"",
				true,
				"static",
				new Set(),
				[],
				new Map(),
				false,
				new Set(),
				image.runtime.stringConstants,
			)!;
			expect(c).toContain(
				["<", "<=", ">", ">="].includes(operator)
					? "mal_string_compare("
					: "mal_string_equals(",
			);
			expect(c).not.toContain("mal_ops_is_number(");
			const instructions = [...fn.instructions];
			instructions[ip] = {
				kind: "exact-operator-input-kinds",
				inputKindMasks: [
					COMPILER_VALUE_KIND_STRING | COMPILER_VALUE_KIND_NUMBER,
					COMPILER_VALUE_KIND_STRING,
				],
			};
			expect(() =>
				serializeCompilerArtifact({
					...restored,
					native: {
						...restored.native,
						functions: restored.native.functions.with(index, { ...fn, instructions }),
					},
				}),
			).toThrow(/invalid exact binary kind masks/);
		},
	);

	it("keeps the coercive path for unknown and mixed operands", () => {
		for (const expression of [
			"left < right",
			"String(left) < +right",
			"String(left) == right",
		]) {
			const out = inspectStaticValueFunction(
				`function compute(left,right){return ${expression};}globalThis.compute=compute;`,
				"compute",
			);
			expect(out.c).not.toContain("mal_string_compare(");
			expect(out.c).not.toContain("mal_string_equals(");
		}
	});
});
