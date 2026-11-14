import { equal, ok } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";
import { unicodeTables } from "../src/compiler/shared/unicode-data.ts";

const header = readFileSync(
	new URL("../runtime/src/unicode_data.h", import.meta.url),
	"utf8",
);

function table(name: string): Array<number> {
	const match = new RegExp(
		`static const u(?:8|16) mal_unicode_${name}\\[\\] = \\{([\\s\\S]*?)\\};`,
	).exec(header);
	ok(match, `Missing native case index table ${name}`);
	return (match[1]!.match(/\d+/g) ?? []).map(Number);
}

describe("Native case mapping index layout", () => {
	it.each(["lower", "upper"] as const)(
		"finds the %s mapping row of every code point the compiler table maps",
		(name) => {
			const bits = Number(/#define MAL_UNICODE_CASE_BLOCK_BITS (\d+)/.exec(header)?.[1]);
			ok(bits > 0);
			const blocks = table(`${name}_blocks`);
			const entries = table(`${name}_entries`);
			equal(entries.length % (1 << bits), 0);
			ok(blocks.every((block) => block < entries.length >> bits));
			const rows = unicodeTables()[name];
			let row = 0;
			for (let cp = 0; cp < 0x110000; cp++) {
				const expected = rows[row * 3] === cp ? ++row : 0;
				const block = cp >>> bits;
				const actual =
					block < blocks.length
						? entries[(blocks[block]! << bits) | (cp & ((1 << bits) - 1))]!
						: 0;
				if (actual !== expected) equal(actual, expected, `${name} U+${cp.toString(16)}`);
			}
			equal(row * 3, rows.length);
		},
	);
});
