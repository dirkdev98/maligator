import { describe, expect, it } from "vitest";
import {
	COMPILER_VALUE_KIND_STRING,
	COMPILER_VALUE_KIND_TOP,
	compilerOperatorInputKindMasksAreValid,
	compilerOperatorInputKindsHaveExactNativeSemantics,
} from "../src/compiler/shared/compiler-value-kinds.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

describe("partial operator input kinds", () => {
	it("validates partial knowledge without certifying primitive effects", () => {
		const masks = [COMPILER_VALUE_KIND_TOP, COMPILER_VALUE_KIND_STRING];
		expect(compilerOperatorInputKindMasksAreValid("binary", masks)).toBe(true);
		expect(compilerOperatorInputKindsHaveExactNativeSemantics("binary", "+", masks)).toBe(
			false,
		);
		for (const invalid of [[0, 16], [256, 16], [16], [16, 16, 16]])
			expect(compilerOperatorInputKindMasksAreValid("binary", invalid)).toBe(false);
	});

	it.each(["left + ':'", "':' + left"])(
		"preserves coercion and roots while removing impossible Number branches in %s",
		(expression) => {
			const out = inspectStaticValueFunction(
				`function compute(left,gate){const result=${expression};gate();return result;}globalThis.compute=compute;`,
				"compute",
			);
			const ip = out.native.body.instructions.findIndex((op) => op.opcode === "BINARY");
			const op = out.native.body.instructions[ip]!;
			if (op.opcode !== "BINARY") throw new Error("Missing addition");
			expect(out.native.facts?.[ip]).toMatchObject({
				inputKindMasks: expression.startsWith("left")
					? [COMPILER_VALUE_KIND_TOP, COMPILER_VALUE_KIND_STRING]
					: [COMPILER_VALUE_KIND_STRING, COMPILER_VALUE_KIND_TOP],
			});
			expect(out.native.gc.safepoints.some((point) => point.instructionIp === ip)).toBe(
				true,
			);
			expect(out.native.storage!.expressionIps).not.toContain(ip);
			expect(out.native.storage!.rootRegisters).toContain(op.dst);
			expect(out.c.source).toContain("mal_vm_binary_op(");
			expect(out.c.source).not.toContain("mal_ops_is_number(");
			expect(out.c.source).not.toContain("mal_vm_concat_primitive_strings(");
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
				out.image,
			);
		},
	);

	it.each([
		"+",
		"-",
		"*",
		"/",
		"%",
		"**",
		"&",
		"|",
		"^",
		"<<",
		">>",
		">>>",
		"<",
		"<=",
		">",
		">=",
		"==",
		"!=",
	])(
		"retains the coercive %s operation when a String operand excludes two Numbers",
		(operator) => {
			const out = inspectStaticValueFunction(
				`function compute(left,right,gate){const text=String(right);gate();return left ${operator} text;}globalThis.compute=compute;`,
				"compute",
			);
			expect(out.c.source).toContain("mal_vm_binary_op(");
			expect(out.c.source).not.toContain("mal_ops_is_number(");
		},
	);

	it("keeps Number speculation for unions that still contain Numbers", () => {
		const out = inspectStaticValueFunction(
			"function compute(left,right,condition){const input=condition?+right:'suffix';return left+input;}globalThis.compute=compute;",
			"compute",
		);
		expect(out.c.source).toContain("mal_ops_is_number(");
		expect(out.c.source).toContain("mal_vm_binary_op(");
	});

	it("does not reuse canonical numeric fusion in a String entry variant", () => {
		const out = inspectStaticValueFunction(
			"function compute(left,right){return (left+right)*3;}globalThis.compute=compute;globalThis.result=compute(globalThis.input,':');",
			"compute",
		);
		expect(
			out.native.directEntries.some((entry) =>
				entry.instructionFacts?.some(
					({ masks }) =>
						masks[0] === COMPILER_VALUE_KIND_TOP &&
						masks[1] === COMPILER_VALUE_KIND_STRING,
				),
			),
		).toBe(true);
		const source = out.c.directEntries[0]!.source;
		expect(source).toContain("mal_vm_binary_op(");
		expect(source).not.toContain("mal_ops_is_number(");
		expect(source).not.toContain("__nf_");
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
			out.image,
		);
	});
});
