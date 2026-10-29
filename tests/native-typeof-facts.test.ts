import { describe, expect, it } from "vitest";
import {
	COMPILER_VALUE_KIND_NULL,
	COMPILER_VALUE_KIND_OBJECT,
	COMPILER_VALUE_KIND_STRING,
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_TOP,
} from "../src/compiler/shared/compiler-value-kinds.ts";
import { instructionInputKind } from "../src/compiler/shared/instruction-facts.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { lowerNativeFunctionStorage } from "../src/compiler/target/lower-native-storage.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

describe("partial typeof operand facts", () => {
	it.each([
		[
			"flag?null:'text'",
			COMPILER_VALUE_KIND_NULL | COMPILER_VALUE_KIND_STRING,
			"mal_value_is_null(",
		],
		[
			"flag?null:function(){}",
			COMPILER_VALUE_KIND_NULL | COMPILER_VALUE_KIND_OBJECT,
			"!mal_value_is_callable(",
		],
		["flag?{}:function(){}", COMPILER_VALUE_KIND_OBJECT, "!mal_value_is_callable("],
		[
			"flag?{}:17",
			COMPILER_VALUE_KIND_OBJECT | COMPILER_VALUE_KIND_NUMBER,
			"mal_value_is_object(",
		],
	] as const)(
		"uses %s independently of the intervening call's effects",
		(value, mask, kernel) => {
			for (const mode of ["plain", "generator", "async", "profile"] as const) {
				const out = inspectStaticValueFunction(
					`${mode === "async" ? "async " : ""}function${mode === "generator" ? "*" : ""} compute(flag,gate){const value=${value};${mode === "generator" ? "yield value;" : mode === "async" ? "await gate(value);" : "gate(value);"}return typeof value === 'object';}globalThis.compute=compute;`,
					"compute",
					{ profile: mode === "profile" },
				);
				const ip = out.native.body.instructions.findIndex(
					(op) => op.opcode === "TYPEOF_COMPARE",
				);
				const op = out.native.body.instructions[ip]!;
				if (op.opcode !== "TYPEOF_COMPARE") throw new Error("Missing typeof comparison");
				expect(instructionInputKind(out.native.facts?.[ip], op.src)).toBe(mask);
				expect(out.c.source).toContain(kernel);
				expect(out.c.source).not.toContain("mal_vm_typeof_compare(");
				const restored = deserializeCompilerArtifact(
					serializeCompilerArtifact(out.image),
				);
				expect(restored.native.functions[out.native.functionIndex]).toEqual(out.native);
			}
		},
	);

	it.each(["plain", "generator", "async", "profile"] as const)(
		"folds a nullable noncallable object comparison across %s effects",
		(mode) => {
			const out = inspectStaticValueFunction(
				`${mode === "async" ? "async " : ""}function${mode === "generator" ? "*" : ""} compute(flag,gate){const value=flag?null:{};${mode === "generator" ? "yield value;" : mode === "async" ? "await gate(value);" : "gate(value);"}return typeof value === 'object';}globalThis.compute=compute;`,
				"compute",
				{ profile: mode === "profile" },
			);
			expect(
				out.native.body.instructions.some((op) => op.opcode === "TYPEOF_COMPARE"),
			).toBe(false);
			expect(
				out.core.some(
					(op) => op.opcode === "createBoolean" && op.attributes.value === true,
				),
			).toBe(true);
			expect(
				out.native.body.instructions.some(
					(op) => op.opcode === (mode === "generator" ? "YIELD" : "CALL"),
				),
			).toBe(true);
			const restored = deserializeCompilerArtifact(serializeCompilerArtifact(out.image));
			expect(restored.native.functions[out.native.functionIndex]).toEqual(out.native);
		},
	);

	it.each([false, true])(
		"shares partial predicates across full and frameless bodies, negated=%s",
		(negated) => {
			const out = inspectStaticValueFunction(
				`function compute(value){return typeof value ${negated ? "!==" : "==="} 'object';}globalThis.compute=compute;`,
				"compute",
			);
			const ip = out.native.body.instructions.findIndex(
				(op) => op.opcode === "TYPEOF_COMPARE",
			);
			for (const mask of [
				COMPILER_VALUE_KIND_NULL | COMPILER_VALUE_KIND_STRING,
				COMPILER_VALUE_KIND_NULL | COMPILER_VALUE_KIND_OBJECT,
				COMPILER_VALUE_KIND_OBJECT,
			]) {
				const row = out.native.facts![ip]!;
				const native = lowerNativeFunctionStorage({
					...out.native,
					facts: out.native.facts!.with(ip, { ...row, inputKindMasks: [mask] }),
				});
				const c = emitCompiledFunction(native, native.functionIndex, "", false)!.source;
				const kernel =
					(mask & COMPILER_VALUE_KIND_OBJECT) === 0
						? "mal_value_is_null"
						: "mal_value_is_callable";
				expect(c).toContain(`${kernel}(__fast_r0)`);
				expect(c).toContain(`${kernel}(r0)`);
				expect(c).not.toContain("mal_vm_typeof_compare(");
			}
		},
	);

	it("retains the full object classifier for an unknown operand", () => {
		const out = inspectStaticValueFunction(
			"function compute(flag,input,gate){const value=flag?null:input;gate(value);return typeof value === 'object';}globalThis.compute=compute;",
			"compute",
		);
		const ip = out.native.body.instructions.findIndex(
			(op) => op.opcode === "TYPEOF_COMPARE",
		);
		const op = out.native.body.instructions[ip]!;
		if (op.opcode !== "TYPEOF_COMPARE")
			throw new Error("Missing general typeof comparison");
		expect(instructionInputKind(out.native.facts?.[ip], op.src)).toBe(
			COMPILER_VALUE_KIND_TOP,
		);
		expect(out.c.source).toContain("mal_vm_typeof_compare(");
	});

	it.each([
		["undefined", "mal_value_is_undefined"],
		["boolean", "mal_value_is_boolean"],
		["number", "mal_ops_is_number"],
		["string", "mal_value_is_string"],
		["bigint", "mal_value_is_bigint"],
		["symbol", "mal_value_is_symbol"],
		["function", "mal_value_is_callable"],
	])(
		"uses the direct %s predicate in full and frameless entries",
		(expected, predicate) => {
			for (const negated of [false, true]) {
				const out = inspectStaticValueFunction(
					`function compute(value){return typeof value ${negated ? "!==" : "==="} '${expected}';}globalThis.compute=compute;`,
					"compute",
				);
				expect(out.c.source).toContain(`${predicate}(__fast_r0)`);
				expect(out.c.source).toContain(`${predicate}(r0)`);
				expect(out.c.source).not.toContain("mal_vm_typeof_compare(");
			}
		},
	);
});
