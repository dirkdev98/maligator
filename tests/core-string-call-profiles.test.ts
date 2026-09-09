import { describe, expect, it } from "vitest";
import { evaluateConstantBuiltin } from "../src/compiler/shared/constant-builtins.ts";
import { PORTABLE_CONSTANT_TARGET } from "../src/compiler/shared/constant-evaluator.ts";
import {
	constantCallProfiles,
	constantCallProfileSource,
} from "./helpers/constant-call-profiles.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";
import {
	constantStringCallCases,
	localeCaseTags,
	localeCaseText,
} from "./helpers/string-call-profiles.ts";

describe("constant string call profiles", () => {
	for (const profile of constantCallProfiles) {
		it.each(constantStringCallCases)(
			`folds %s through ${profile} while retaining effects`,
			(...entry) => {
				const out = inspectStaticValueFunction(
					constantCallProfileSource(entry, profile),
					"probe",
					{ intl: true },
				);
				expect(out.structure.genericLookups).toBe(0);
				expect(out.structure.genericCalls).toBe(
					profile === "effects" || profile === "unused" ? 2 : 1,
				);
				expect(out.structure.allocations).toBe(0);
				expect(out.structure.coercions).toBe(0);
				expect(
					out.core.filter(
						(op) => op.opcode === "callKnown" || op.opcode === "builtinError",
					),
				).toEqual([]);
			},
		);
		it.each(constantStringCallCases)(
			`retains mutable %s through ${profile}`,
			(...entry) => {
				const out = inspectStaticValueFunction(
					constantCallProfileSource(entry, profile),
					"probe",
					{ locked: false, intl: true },
				);
				expect(out.structure.genericLookups).toBeGreaterThan(0);
				expect(out.structure.genericCalls).toBeGreaterThan(
					profile === "effects" || profile === "unused" ? 2 : 1,
				);
			},
		);
	}
});

describe("constant locale case conversion", () => {
	for (const intl of [true, false]) {
		for (const upper of [true, false]) {
			it.each(localeCaseTags)(
				`selects the certified locale %s with intl=${intl}, upper=${upper}`,
				(locale) => {
					const method = upper ? "toLocaleUpperCase" : "toLocaleLowerCase";
					const out = inspectStaticValueFunction(
						`function probe(){return ${JSON.stringify(localeCaseText)}.${method}(${JSON.stringify(locale)});}globalThis.probe=probe;`,
						"probe",
						{ intl },
					);
					const expected = intl
						? localeCaseText[method](locale)
						: upper
							? localeCaseText.toUpperCase()
							: localeCaseText.toLowerCase();
					expect(out.core.map((op) => op.opcode)).toEqual(["createString"]);
					const literal = out.fn.instructions.find((op) => op.opcode === "CREATE_STRING");
					if (literal === undefined) throw new Error("Missing folded string");
					expect(
						String.fromCharCode(
							...out.image.runtime.stringConstants[literal.stringIndex]!,
						),
					).toBe(expected);
				},
			);
		}
	}
	it.each(["x", "['tr']", "'tr-TR'", "'bad!'", "null", "new String('tr')"])(
		"retains locale canonicalization for %s",
		(locale) => {
			const out = inspectStaticValueFunction(
				`function probe(x){return 'I'.toLocaleLowerCase(${locale});}globalThis.probe=probe;`,
				"probe",
				{ intl: true },
			);
			expect(
				out.core.some(
					(op) => op.attributes.operation === "String.prototype.toLocaleLowerCase",
				),
			).toBe(true);
		},
	);
	it("retains locale argument evaluation when the Intl-disabled runtime ignores its value", () => {
		const out = inspectStaticValueFunction(
			"function probe(x){return 'I'.toLocaleLowerCase(x());}globalThis.probe=probe;",
			"probe",
			{ intl: false },
		);
		expect(out.structure.genericCalls).toBe(1);
		expect(out.core.some((op) => op.opcode === "callKnown")).toBe(false);
	});
	it("requires an explicit Intl and Unicode target certificate for locale-specific results", () => {
		const receiver = { kind: "string", value: "I" } as const;
		const args = [{ kind: "string", value: "tr" }] as const;
		for (const target of [
			PORTABLE_CONSTANT_TARGET,
			{ ...PORTABLE_CONSTANT_TARGET, intl: true, unicode: "uncertified" },
		]) {
			expect(
				evaluateConstantBuiltin(
					"String.prototype.toLocaleLowerCase",
					receiver,
					args,
					target,
				).kind,
			).toBe("unsupported");
		}
	});
});
