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
		`static const (?:u8|u32|i32) mal_unicode_${name}\\[\\] = \\{([\\s\\S]*?)\\};`,
	).exec(header);
	ok(match, `Missing native case index table ${name}`);
	return (match[1]!.match(/-?\d+/g) ?? []).map(Number);
}

describe("Native case mapping index layout", () => {
	it.each(["lower", "upper"] as const)(
		"decodes exact %s mappings for every code point",
		(name) => {
			const bits = Number(/#define MAL_UNICODE_CASE_BLOCK_BITS (\d+)/.exec(header)?.[1]);
			ok(bits > 0);
			const blocks = table(`${name}_blocks`);
			const entries = table(`${name}_entries`);
			const mappings = table(`${name}_mappings`);
			const expansions = table("case_expansions");
			const expansionBase = Number(
				/#define MAL_UNICODE_CASE_EXPANSION_BASE (\d+)/.exec(header)?.[1],
			);
			ok(expansionBase >= 0x110000);
			equal(entries.length % (1 << bits), 0);
			ok(blocks.every((block) => block < entries.length >> bits));
			ok(entries.every((entry) => entry < mappings.length));
			const compiler = unicodeTables();
			const rows = compiler[name];
			let row = 0;
			for (let cp = 0; cp < 0x110000; cp++) {
				const block = cp >>> bits;
				const entry =
					block < blocks.length
						? entries[(blocks[block]! << bits) | (cp & ((1 << bits) - 1))]!
						: 0;
				const mapping = mappings[entry]!;
				if (rows[row * 3] !== cp) {
					if (mapping !== 0) equal(mapping, 0, `${name} U+${cp.toString(16)}`);
					continue;
				}
				const offset = rows[row * 3 + 1]!;
				const count = rows[row * 3 + 2]!;
				if (mapping < expansionBase) {
					equal(count, 1);
					equal(cp + mapping, compiler.pool[offset]);
				} else {
					const expansion = mapping - expansionBase;
					equal(expansion & 3, count);
					for (let index = 0; index < count; index++)
						equal(expansions[(expansion >>> 2) + index], compiler.pool[offset + index]);
				}
				row++;
			}
			equal(row * 3, rows.length);
		},
	);

	it("preserves the combining-class categories that change contextual casing", () => {
		const bits = Number(/#define MAL_UNICODE_CASE_BLOCK_BITS (\d+)/.exec(header)?.[1]);
		const blocks = table("case_class_blocks");
		const entries = table("case_class_entries");
		const classes = unicodeTables().classes;
		let index = 0;
		for (let cp = 0; cp < 0x110000; cp++) {
			const value = classes[index] === cp ? classes[index + 1]! : 0;
			if (value !== 0) index += 2;
			const expected = value === 230 ? 2 : value === 0 ? 0 : 1;
			const block = blocks[cp >>> bits];
			const offset = ((block ?? 0) << bits) | (cp & ((1 << bits) - 1));
			const actual =
				block === undefined ? 0 : (entries[offset >>> 2]! >>> ((offset & 3) * 2)) & 3;
			if (actual !== expected)
				equal(actual, expected, `Combining class U+${cp.toString(16)}`);
		}
		equal(index, classes.length);
	});
});
