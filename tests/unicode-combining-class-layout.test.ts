import { equal, ok } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";
import { unicodeTables } from "../src/compiler/shared/unicode-data.ts";

const source = readFileSync(
	new URL("../runtime/src/unicode_data.h", import.meta.url),
	"utf8",
);

function table(name: string): Array<number> {
	const match = new RegExp(
		`(?:static )?const u8 mal_unicode_${name}\\[\\] = \\{([\\s\\S]*?)\\};`,
	).exec(source);
	ok(match, `Missing native combining-class table ${name}`);
	return (match[1]!.match(/\d+/g) ?? []).map(Number);
}

describe("Native combining-class table layout", () => {
	it("preserves every Unicode code point and default zero class against the compiler table", () => {
		const size = /^#define MAL_UNICODE_CLASS_BLOCK_BITS (\d+)$/m.exec(source);
		ok(size, "Missing native combining-class block size");
		const bits = Number(size[1]);
		const width = 2 ** bits;
		const blocks = table("class_blocks");
		const values = table("class_values");
		ok(blocks.length <= 0x110000 / width);
		equal(values.length % width, 0);
		ok(values.length / width <= 256);
		ok(blocks.every((block) => block >= 0 && block < values.length / width));
		ok(values.every((value) => value >= 0 && value <= 255));
		let entry = 0;
		for (let cp = 0; cp < 0x110000; cp++) {
			const expected =
				unicodeTables().classes[entry] === cp ? unicodeTables().classes[entry + 1]! : 0;
			if (unicodeTables().classes[entry] === cp) entry += 2;
			const block = blocks[cp >>> bits];
			const actual = block === undefined ? 0 : values[block * width + (cp & (width - 1))];
			if (actual !== expected)
				equal(actual, expected, `Combining class U+${cp.toString(16)}`);
		}
		equal(entry, unicodeTables().classes.length);
	});
});
