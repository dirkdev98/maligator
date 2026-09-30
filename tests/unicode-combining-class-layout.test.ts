import { equal, ok } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";
import { unicodeClasses } from "../src/compiler/shared/unicode-data.ts";

function table(name: string): Array<number> {
	const source = readFileSync(
		new URL("../runtime/src/unicode_data.h", import.meta.url),
		"utf8",
	);
	const match = new RegExp(
		`static const u8 mal_unicode_${name}\\[\\] = \\{([\\s\\S]*?)\\};`,
	).exec(source);
	ok(match, `Missing native combining-class table ${name}`);
	return (match[1]!.match(/\d+/g) ?? []).map(Number);
}

describe("Native combining-class table layout", () => {
	it("preserves every Unicode code point and default zero class against the compiler table", () => {
		const pages = table("class_pages");
		const values = table("class_values");
		equal(pages.length, 0x1100);
		equal(values.length % 256, 0);
		ok(values.length / 256 <= 256);
		ok(pages.every((page) => page >= 0 && page < values.length / 256));
		ok(values.every((value) => value >= 0 && value <= 255));
		let entry = 0;
		for (let cp = 0; cp < 0x110000; cp++) {
			const expected = unicodeClasses[entry] === cp ? unicodeClasses[entry + 1]! : 0;
			if (unicodeClasses[entry] === cp) entry += 2;
			const actual = values[pages[cp >>> 8]! * 256 + (cp & 255)];
			if (actual !== expected)
				equal(actual, expected, `Combining class U+${cp.toString(16)}`);
		}
		equal(entry, unicodeClasses.length);
	});
});
