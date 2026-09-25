import { describe, expect, it } from "vitest";
import { evaluateConstantBuiltin } from "../src/compiler/shared/constant-builtins.ts";
import { PORTABLE_CONSTANT_TARGET } from "../src/compiler/shared/constant-evaluator.ts";
import {
	constantCallProfiles,
	constantCallProfileSource,
} from "./helpers/constant-call-profiles.ts";
import {
	dynamicCallProfiles,
	dynamicCallProfileSource,
} from "./helpers/dynamic-call-profiles.ts";
import { inspectStaticValueFunction, staticValueCases } from "./helpers/static-values.ts";
import {
	constantStringCallCases,
	dynamicStringCallCases,
	localeCaseTags,
	localeCaseText,
} from "./helpers/string-call-profiles.ts";

describe("constant string call profiles", () => {
	for (const profile of constantCallProfiles) {
		describe(profile, () => {
			it.each(
				staticValueCases(
					constantStringCallCases,
					(entry, name) => constantCallProfileSource(entry, profile, name),
					{ intl: true },
				),
			)(
				`folds %s through ${profile} while retaining effects`,
				(_name, _entry, inspect) => {
					const out = inspect();
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
			it.each(
				staticValueCases(
					constantStringCallCases,
					(entry, name) => constantCallProfileSource(entry, profile, name),
					{ locked: false, intl: true },
				),
			)(`retains mutable %s through ${profile}`, (_name, _entry, inspect) => {
				const out = inspect();
				expect(out.structure.genericLookups).toBeGreaterThan(0);
				expect(out.structure.genericCalls).toBeGreaterThan(
					profile === "effects" || profile === "unused" ? 2 : 1,
				);
			});
		});
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

describe("dynamic string call profiles", () => {
	for (const profile of dynamicCallProfiles) {
		describe(profile, () => {
			it.each(
				staticValueCases(
					dynamicStringCallCases,
					(entry, name) =>
						dynamicCallProfileSource(
							[entry[0], entry[1], entry[2]],
							profile,
							entry[3],
							name,
						),
					{ intl: true },
				),
			)(
				`specializes %s through ${profile} after one conversion`,
				(_name, [callee, , , expression], inspect) => {
					const out = inspect();
					expect(out.structure.genericLookups).toBe(0);
					expect(out.structure.allocations).toBe(0);
					const conversions = out.core.filter((op) =>
						expression === "+x"
							? op.opcode === "unary" && op.attributes.operator === "+"
							: op.opcode === "callKnown" && op.attributes.operation === "String",
					);
					expect(conversions).toHaveLength(1);
					if (profile === "repeated" || profile === "repeatedLoop")
						expect(
							out.core.filter(
								(op) => op.opcode === "callKnown" && op.attributes.operation !== "String",
							).length,
						).toBeLessThanOrEqual(1);
					if (callee !== "String.prototype.concat") {
						expect(out.c.source.match(/mal_vm_call_known_native\(/g) ?? []).toHaveLength(
							expression === "String(x)" ? 1 : 0,
						);
					}
				},
			);
			it.each(
				staticValueCases(
					dynamicStringCallCases,
					(entry, name) =>
						dynamicCallProfileSource(
							[entry[0], entry[1], entry[2]],
							profile,
							entry[3],
							name,
						),
					{ locked: false, intl: true },
				),
			)(`retains mutable %s through ${profile}`, (_name, _entry, inspect) => {
				const out = inspect();
				expect(out.structure.genericLookups).toBeGreaterThan(0);
				expect(out.structure.genericCalls).toBeGreaterThan(0);
			});
		});
	}
	it.each(["includes", "indexOf", "lastIndexOf", "startsWith", "endsWith"])(
		"uses the string search entry for proved %s inputs",
		(method) => {
			const out = inspectStaticValueFunction(
				`function probe(x,y,p){const s=String(x),n=String(y),i=+p;return s.${method}(n,i);}globalThis.probe=probe;`,
				"probe",
			);
			expect(out.c.source).toContain("mal_builtin_string_search_strings(");
			expect(out.c.source).not.toContain("mal_builtin_string_search_direct(");
			expect(out.c.source.match(/mal_vm_call_known_native\(/g) ?? []).toHaveLength(2);
		},
	);
	it.each(["includes", "indexOf", "lastIndexOf", "startsWith", "endsWith"])(
		"retains the guarded %s entry for unknown search values",
		(method) => {
			const out = inspectStaticValueFunction(
				`function probe(x,y,p){return String(x).${method}(y,+p);}globalThis.probe=probe;`,
				"probe",
			);
			expect(out.c.source).toContain("mal_builtin_string_search_direct(");
			expect(out.c.source).not.toContain("mal_builtin_string_search_strings(");
		},
	);
});
