import { describe, expect, it } from "vitest";
import {
	evaluateConstantOperation,
	PORTABLE_CONSTANT_TARGET,
} from "../src/compiler/shared/constant-evaluator.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

describe("target-certified constant evaluation", () => {
	it("preserves Number exponentiation special cases across signs, zero and infinities", () => {
		for (const base of [-Infinity, -2, -1, -0, 0, 1, 2, Infinity, NaN]) {
			for (const exponent of [-Infinity, -3, -0.5, -0, 0, 0.5, 1, 2, 3, Infinity, NaN]) {
				const result = evaluateConstantOperation("number.binary:**", [
					{ kind: "number", value: base },
					{ kind: "number", value: exponent },
				]);
				if (result.kind === "value" && result.value.kind === "number")
					expect(
						Object.is(result.value.value, base ** exponent),
						`${base} ** ${exponent}`,
					).toBe(true);
			}
		}
	});
	it.each(["little", "big"] as const)(
		"preserves binary64 values independently of %s byte order",
		(endianness) => {
			const target = { ...PORTABLE_CONSTANT_TARGET, endianness };
			for (const [operator, left, right, expected] of [
				["/", -0, 2, -0],
				["/", -1, 0, -Infinity],
				["+", Number.MIN_VALUE, Number.MIN_VALUE, 1e-323],
				["/", Number.MIN_VALUE, 2, 0],
				["+", 9007199254740992, 1, 9007199254740992],
				["%", -4, 2, -0],
			] as const) {
				const result = evaluateConstantOperation(
					`number.binary:${operator}`,
					[
						{ kind: "number", value: left },
						{ kind: "number", value: right },
					],
					target,
				);
				expect(result).toMatchObject({ kind: "value", value: { kind: "number" } });
				if (result.kind !== "value" || result.value.kind !== "number")
					throw new Error("Expected a number");
				expect(Object.is(result.value.value, expected)).toBe(true);
			}
		},
	);

	it("reports target and resource limits without executing uncertified operations", () => {
		expect(
			evaluateConstantOperation("Intl.NumberFormat.format", [
				{ kind: "number", value: 42 },
			]),
		).toMatchObject({ kind: "unsupported", reason: "uncertified-operation" });
		expect(
			evaluateConstantOperation(
				"number.binary:+",
				[
					{ kind: "number", value: 1 },
					{ kind: "number", value: 2 },
				],
				{ ...PORTABLE_CONSTANT_TARGET, numbers: "uncertified" },
			),
		).toMatchObject({ kind: "unsupported", reason: "target-contract" });
		expect(
			evaluateConstantOperation(
				"number.binary:**",
				[
					{ kind: "number", value: 2 },
					{ kind: "number", value: -1074 },
				],
				PORTABLE_CONSTANT_TARGET,
				10,
			),
		).toMatchObject({ kind: "unsupported", reason: "work-limit" });
		expect(
			evaluateConstantOperation("number.binary:**", [
				{ kind: "number", value: 1.00001 },
				{ kind: "number", value: 1.23 },
			]),
		).toMatchObject({ kind: "unsupported", reason: "uncertified-operation" });
	});

	it("keeps UTF-16 code units including isolated surrogates", () => {
		expect(
			evaluateConstantOperation("string.code-unit", [
				{ kind: "string", value: "\ud800x" },
				{ kind: "number", value: 0 },
			]),
		).toMatchObject({ kind: "value", value: { kind: "number", value: 0xd800 } });
		expect(
			evaluateConstantOperation("string.length", [
				{ kind: "string", value: "\ud83d\ude00\ud800" },
			]),
		).toMatchObject({ kind: "value", value: { kind: "number", value: 3 } });
	});

	it("checks BigInt limits before arithmetic and returns a residual throw description", () => {
		const max = (1n << 127n) - 1n;
		const binary = (operator: string, a: bigint, b: bigint) =>
			evaluateConstantOperation(`bigint.binary:${operator}`, [
				{ kind: "bigint", value: a },
				{ kind: "bigint", value: b },
			]);
		expect(binary("+", max, 1n)).toMatchObject({
			kind: "unsupported",
			reason: "target-contract",
		});
		expect(binary("*", max, max)).toMatchObject({
			kind: "unsupported",
			reason: "target-contract",
		});
		expect(binary("/", -max - 1n, -1n)).toMatchObject({
			kind: "unsupported",
			reason: "target-contract",
		});
		expect(binary("%", -max - 1n, -1n)).toMatchObject({
			kind: "value",
			value: { kind: "bigint", value: 0n },
		});
		expect(binary("/", 2n, 0n)).toMatchObject({
			kind: "throw",
			error: "RangeError",
			stage: "invocation",
		});
		expect(binary("*", 123456789n, 987654321n)).toMatchObject({
			kind: "value",
			value: { kind: "bigint", value: 121932631112635269n },
		});
	});

	it("uses certified folds in Core and leaves uncertified powers at runtime", () => {
		const folded = inspectStaticValueFunction(
			"function probe(){return 2 ** 10;} globalThis.probe=probe;",
			"probe",
		);
		const residual = inspectStaticValueFunction(
			"function probe(){return 1.00001 ** 1.23;} globalThis.probe=probe;",
			"probe",
		);
		expect(folded.core.some((operation) => operation.opcode === "binary")).toBe(false);
		expect(
			residual.core.some(
				(operation) =>
					operation.opcode === "binary" && operation.attributes.operator === "**",
			),
		).toBe(true);
	});
});
