import { deepStrictEqual, equal, ok } from "node:assert";
import { describe, it } from "vitest";
import { normalizeUnicode } from "../src/compiler/shared/unicode-transform.ts";

const forms = ["NFC", "NFD", "NFKC", "NFKD"] as const;

describe("Normalization combining-class reuse", () => {
	it("preserves canonical ordering, composition, Hangul and surrogate handling", () => {
		const sources = [
			"",
			"ASCII",
			"e\u0301\u0327",
			"A\u030a\u0301",
			"a\u0315\u0300",
			"\u00e9\u00c5\u212b",
			"\ufb03\u00a0",
			"\uac01\u1100\u1161\u11a8",
			"\u0301\u0327a",
			"\ud83d\ude00e\u0301",
			"\ud800X\udfff",
		];
		for (const source of sources) {
			for (const form of forms) {
				const result = normalizeUnicode(source, form, 10000);
				ok(result);
				equal(result.value, source.normalize(form));
			}
		}
	});

	it("preserves exact budget boundaries and existing work accounting", () => {
		deepStrictEqual(normalizeUnicode("a", "NFD", 3), { value: "a", work: 3 });
		deepStrictEqual(normalizeUnicode("a", "NFC", 4), { value: "a", work: 4 });
		for (const form of forms) {
			for (const source of ["a\u0315\u0300", "\uac01", "\ufb03", "\ud83d\ude00"]) {
				const result = normalizeUnicode(source, form, 10000);
				ok(result);
				deepStrictEqual(normalizeUnicode(source, form, result.work), result);
				equal(normalizeUnicode(source, form, result.work - 1), undefined);
			}
		}
	});

	it("keeps classes aligned while moving long runs of combining marks", () => {
		const source = `a${"\u0315\u0300\u0327".repeat(30)}`;
		for (const form of forms) {
			const result = normalizeUnicode(source, form, 100000);
			ok(result);
			equal(result.value, source.normalize(form));
			equal(normalizeUnicode(source, form, 100), undefined);
		}
	});
});
