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

describe("proven String operations in boxed storage", () => {
	it.each(
		["+", "<", "<=", ">", ">=", "==", "!=", "===", "!=="].flatMap((operator) =>
			[false, true].map((profile) => [operator, profile] as const),
		),
	)(
		"roundtrips and emits the exact String kernel for %s with profiling=%s",
		(operator, profile) => {
			const out = inspectStaticValueFunction(
				`function compute(left,right,gate){const a=String(left);const b=String(right);gate();return a ${operator} b;}globalThis.compute=compute;`,
				"compute",
				{ profile },
			);
			const ip = out.native.body.instructions.findIndex(
				(op) => op.opcode === "BINARY" && op.operator === operator,
			);
			const op = out.native.body.instructions[ip]!;
			if (op.opcode !== "BINARY") throw new Error("Missing String operation");
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
			const encoded = serializeCompilerArtifact(image);
			const restored = deserializeCompilerArtifact(encoded);
			if (!profile) expect(restored).toEqual(image);
			expect(serializeCompilerArtifact(restored)).toEqual(encoded);
			const index = image.native.functions.indexOf(
				image.native.functions.find((fn) => fn.body === out.native.body)!,
			);
			const fn = (profile ? image : restored).native.functions[index]!;
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
			expect(c.source).toContain(
				operator === "+"
					? "mal_vm_concat_strings_known("
					: ["<", "<=", ">", ">="].includes(operator)
						? "mal_string_compare("
						: "mal_string_equals(",
			);
			expect(c.source).not.toContain("mal_ops_is_number(");
			expect(c.source.includes("MAL_PROFILE_SITE_RUNTIME_STRING")).toBe(profile);
			const restoredFn = restored.native.functions[index]!;
			const instructions = [...restoredFn.instructions];
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
						functions: restored.native.functions.with(index, {
							...restoredFn,
							instructions,
						}),
					},
				}),
			).toThrow(/invalid exact binary kind masks/);
		},
	);

	it.each([false, true])(
		"consumes String entry proofs while preserving fusion ownership=%s",
		(fusion) => {
			const out = inspectStaticValueFunction(
				`function compute(left,right){return ${fusion ? "(left+right)*3" : "left+right"};}globalThis.compute=compute;globalThis.output=compute(String(globalThis.left),String(globalThis.right));`,
				"compute",
			);
			const op = out.native.body.instructions.find(
				(op) => op.opcode === "BINARY" && op.operator === "+",
			)!;
			if (op.opcode !== "BINARY") throw new Error("Missing concat");
			const ip = out.native.body.instructions.indexOf(op);
			const entry = out.native.directEntries[0]!;
			expect(entry.operatorInputs).toContainEqual({
				instructionIp: ip,
				masks: [COMPILER_VALUE_KIND_STRING, COMPILER_VALUE_KIND_STRING],
			});
			expect(
				out.native.specializations.some((region) => region.kind === "numeric-fusion"),
			).toBe(fusion);
			const image = lowerNativeStorage({
				...out.image,
				native: {
					...out.image.native,
					functions: out.image.native.functions.map((fn) =>
						fn !== out.native
							? fn
							: {
									...fn,
									directEntries: fn.directEntries.map((variant) => ({
										...variant,
										registerRepresentations: variant.registerRepresentations.map(
											(rep, local) => (local === op.dst ? "boxed" : rep),
										),
									})),
								},
					),
				},
			});
			const restored = deserializeCompilerArtifact(serializeCompilerArtifact(image));
			expect(restored).toEqual(image);
			const fn = restored.native.functions[out.native.functionIndex]!;
			const c = emitCompiledFunction(fn, fn.functionIndex, "", false)!;
			const source = c.directEntries[0]!.source;
			if (fusion) {
				expect(source).not.toContain("mal_vm_concat_strings_known(");
				expect(source).toContain(`__nf_${ip}_ok = mal_ops_is_number(`);
				expect(source).toContain(`if (__nf_${ip}_ok)`);
			} else {
				expect(source).toContain("mal_vm_concat_strings_known(");
				expect(source).not.toContain("mal_ops_is_number(");
			}
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
			expect(out.c.source).not.toContain("mal_string_compare(");
			expect(out.c.source).not.toContain("mal_string_equals(");
		}
	});
});
