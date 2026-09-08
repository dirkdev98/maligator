import { describe, expect, it } from "vitest";
import { evaluateConstantBuiltin } from "../src/compiler/shared/constant-builtins.ts";
import { PORTABLE_CONSTANT_TARGET } from "../src/compiler/shared/constant-evaluator.ts";
import {
	normalizeUnicode,
	transformUnicodeCase,
} from "../src/compiler/shared/unicode-transform.ts";

const normalizationCases = [
	["\u1e0a\u0323", "\u1e0c\u0307", "D\u0323\u0307", "\u1e0c\u0307", "D\u0323\u0307"],
	["\u212b", "\u00c5", "A\u030a", "\u00c5", "A\u030a"],
	["\ufb03", "\ufb03", "\ufb03", "ffi", "ffi"],
	["\u1100\u1161\u11a8", "\uac01", "\u1100\u1161\u11a8", "\uac01", "\u1100\u1161\u11a8"],
	["\u0958", "\u0915\u093c", "\u0915\u093c", "\u0915\u093c", "\u0915\u093c"],
	[
		"\ud800A\u030a\udfff",
		"\ud800\u00c5\udfff",
		"\ud800A\u030a\udfff",
		"\ud800\u00c5\udfff",
		"\ud800A\u030a\udfff",
	],
] as const;

describe("pinned Unicode transforms", () => {
	it.each(normalizationCases)(
		"normalizes decomposition, composition and exclusions for %s",
		(source, ...expected) => {
			for (const [index, form] of (["NFC", "NFD", "NFKC", "NFKD"] as const).entries())
				expect(normalizeUnicode(source, form)?.value).toBe(expected[index]);
		},
	);
	it.each([
		["Straße ﬃ", "STRASSE FFI", "straße ﬃ"],
		["ΟΣ ΟΣΑ ΟΣ\u0301", "ΟΣ ΟΣΑ ΟΣ\u0301", "ος οσα ος\u0301"],
		["AΣ'A AΣ'", "AΣ'A AΣ'", "aσ'a aς'"],
		["\u{10400}\u{10428}\ud800", "\u{10400}\u{10400}\ud800", "\u{10428}\u{10428}\ud800"],
		["İı", "İI", "i\u0307ı"],
	])("preserves full case mappings and context for %s", (source, upper, lower) => {
		expect(transformUnicodeCase(source, true)?.value).toBe(upper);
		expect(transformUnicodeCase(source, false)?.value).toBe(lower);
	});
	it("applies language-specific context to the original string", () => {
		for (const locale of ["tr", "az"] as const) {
			expect(
				transformUnicodeCase("I\u0323\u0307 I\u0301\u0307 iı", false, locale)?.value,
			).toBe("i\u0323 ı\u0301\u0307 iı");
			expect(transformUnicodeCase("iı", true, locale)?.value).toBe("İI");
		}
		expect(
			transformUnicodeCase("I\u0323\u0301 J\u0300 Į\u0301 Ì Í Ĩ", false, "lt")?.value,
		).toBe(
			"i\u0307\u0323\u0301 j\u0307\u0300 į\u0307\u0301 i\u0307\u0300 i\u0307\u0301 i\u0307\u0303",
		);
		expect(transformUnicodeCase("i\u0323\u0307 i\u0301\u0307", true, "lt")?.value).toBe(
			"I\u0323 I\u0301\u0307",
		);
	});
	it("bounds decomposition expansion, combining-order work and emitted UTF-16", () => {
		expect(normalizeUnicode("\ufdfa".repeat(100), "NFKD", 100)).toBeUndefined();
		expect(
			normalizeUnicode(`a${"\u0301".repeat(100)}${"\u0323".repeat(100)}`, "NFC", 1000),
		).toBeUndefined();
		expect(transformUnicodeCase("ß".repeat(100), true, "und", 200)).toBeUndefined();
	});
	it("refuses a mismatched Unicode or default-locale certificate", () => {
		for (const operation of ["normalize", "toUpperCase", "toLowerCase"])
			expect(
				evaluateConstantBuiltin(
					`String.prototype.${operation}`,
					{ kind: "string", value: "é" },
					[],
					{ ...PORTABLE_CONSTANT_TARGET, unicode: "16.0.0" },
				).kind,
			).toBe("unsupported");
		expect(
			evaluateConstantBuiltin(
				"String.prototype.toLocaleLowerCase",
				{ kind: "string", value: "I" },
				[],
				{ ...PORTABLE_CONSTANT_TARGET, locale: "tr" },
			).kind,
		).toBe("unsupported");
	});
});
