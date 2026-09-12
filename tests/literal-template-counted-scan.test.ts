import { deepStrictEqual, equal, throws } from "node:assert";
import { describe, it } from "vitest";
import { scanLiteralTemplateSegment } from "../src/compiler/shared/literal-template-data.ts";

describe("Literal-template counted traversal", () => {
	it("preserves nested property, string and bigint references at a nonzero offset", () => {
		const data = [0, 9, 2, 10, 11, 8, 3, 5, 4, 6, 7, 11, 10, 12, 9, 1, 10, 13, 5, 14, 2];
		deepStrictEqual(scanLiteralTemplateSegment(data, 1, "fixture"), {
			endOffset: 20,
			stringReferences: [
				{ position: 4, index: 11 },
				{ position: 8, index: 4 },
				{ position: 13, index: 12 },
				{ position: 17, index: 13 },
				{ position: 19, index: 14 },
			],
			bigintReferences: [{ position: 10, index: 7 }],
		});
	});

	it("handles wide containers, empty containers and deep nesting", () => {
		const wide = [8, 10000, ...new Array<number>(10000).fill(0)];
		equal(scanLiteralTemplateSegment(wide, 0, "wide").endOffset, wide.length);
		deepStrictEqual(scanLiteralTemplateSegment([8, 2, 8, 0, 9, 0], 0, "empty"), {
			endOffset: 6,
			stringReferences: [],
			bigintReferences: [],
		});
		const deep: Array<number> = [];
		for (let depth = 0; depth < 5000; depth++) deep.push(8, 1);
		deep.push(5, 42);
		deepStrictEqual(scanLiteralTemplateSegment(deep, 0, "deep").stringReferences, [
			{ position: deep.length - 1, index: 42 },
		]);
	});

	it("retains malformed count, property-tag and truncation diagnostics", () => {
		throws(
			() => scanLiteralTemplateSegment([8, 2, 0], 0, "fixture"),
			/Truncated fixture node/,
		);
		throws(
			() => scanLiteralTemplateSegment([9, 1, 5, 0], 0, "fixture"),
			/Unknown fixture object tag 5/,
		);
		throws(
			() => scanLiteralTemplateSegment([8, -1], 0, "fixture"),
			/Invalid fixture array length -1/,
		);
		throws(
			() => scanLiteralTemplateSegment([9, 1, 10, 0], 0, "fixture"),
			/Truncated fixture node/,
		);
	});
});
