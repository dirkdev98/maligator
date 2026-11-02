import { describe, expect, it } from "vitest";
import {
	FfiJsonReader,
	ffiJsonChunks,
	ffiJsonEqual,
	reviveFfiJson,
} from "../src/ffi/json.ts";
import { FfiText, textMatches } from "../src/ffi/text.ts";

describe("FFI JSON text", () => {
	it.each(["", "\t"])(
		"preserves long Unicode and escaped documentation with indentation %j",
		(indent) => {
			const doc = 'Grüße🙂 "quoted" \\ newline\n'.repeat(30_000);
			const value = {
				doc: new FfiText([doc.slice(0, 17), doc.slice(17)]),
				values: [null, false, -1.25, { ["__proto__"]: "ordinary data" }],
			};
			const encoded = [...ffiJsonChunks(value, indent)].join("");
			expect(JSON.parse(encoded)).toEqual({ ...value, doc });
			const decoded = reviveFfiJson(new FfiJsonReader(Buffer.from(encoded)).read());
			expect(ffiJsonEqual(decoded, value)).toBe(true);
			expect([...ffiJsonChunks(decoded, indent)].join("")).toBe(encoded);
		},
	);

	it("preserves escaped surrogate pairs across decoding fragments", () => {
		const body = `${"x".repeat(256 * 1024 - 3)}\\ud83d\\ude42${"y".repeat(256 * 1024)}`;
		const encoded = `"${body}"`;
		const value = new FfiJsonReader(Buffer.from(encoded)).read();
		expect(value).toBeInstanceOf(FfiText);
		expect(JSON.parse([...ffiJsonChunks(value)].join(""))).toBe(JSON.parse(encoded));
	});

	it("rejects invalid escapes in long text", () => {
		expect(() =>
			new FfiJsonReader(Buffer.from(`"${"x".repeat(300_000)}\\q"`)).read(),
		).toThrow(/JSON/);
	});

	it.each([
		["free", "dom", false],
		["caller", "X", false],
		["free", " ", true],
		["caller", ".", true],
		["fre", "ed", true],
		["free", "dX", false],
	] as const)("keeps real word boundaries around %s%s", (left, right, expected) => {
		const text = `${"x".repeat(256 * 1024 - left.length - 1)} ${left}${right}`;
		expect(textMatches(new FfiText([text]), /\b(?:free(?:s|d)?|caller)\b/i)).toBe(
			expected,
		);
	});

	it("does not manufacture a word boundary at the retained search prefix", () => {
		const text = `${"x".repeat(256 * 1024 - 129)}sfree${" ".repeat(124)}tail`;
		expect(textMatches(new FfiText([text]), /\bfree\b/i)).toBe(false);
	});
});
