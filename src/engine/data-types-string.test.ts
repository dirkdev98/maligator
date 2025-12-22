import { expect, test } from "vitest";
import { EngineValue } from "./data-types.ts";

test.for([0, 1, 3, 5])(
	"stringIndexOf returns fromIndex when the search string is empty, fromIndex: %s",
	(fromIndex) => {
		const str = EngineValue.string("hello");
		const search = EngineValue.string("");
		const result = str.stringIndexOf(search, fromIndex);
		expect(result).toBe(fromIndex);
	},
);

test("stringIndexOf returns -1 when search string not found", () => {
	const str = EngineValue.string("hello");
	const search = EngineValue.string("xyz");
	const result = str.stringIndexOf(search, 0);
	expect(result).toBe(-1);
});

test("stringIndexOf finds substring at various positions", () => {
	const str = EngineValue.string("hello world");
	const search = EngineValue.string("lo");
	const result = str.stringIndexOf(search, 0);
	expect(result).toBe(3);
});

test.for([
	{ fromIndex: 0, expected: 0 },
	{ fromIndex: 1, expected: 6 },
	{ fromIndex: 6, expected: 6 },
])(
	"stringIndexOf respects fromIndex parameter, fromIndex: %s",
	({ fromIndex, expected }) => {
		const str = EngineValue.string("hello hello");
		const search = EngineValue.string("hello");
		const result = str.stringIndexOf(search, fromIndex);
		expect(result).toBe(expected);
	},
);

test("stringIndexOf handles edge cases", () => {
	const str = EngineValue.string("a");
	const search = EngineValue.string("a");
	const result = str.stringIndexOf(search, 0);
	expect(result).toBe(0);
});

test("stringLastIndexOf finds substring from end", () => {
	const str = EngineValue.string("hello hello");
	const search = EngineValue.string("hello");
	const result = str.stringLastIndexOf(search, 6);
	expect(result).toBe(6);
});

test("stringLastIndexOf returns -1 when search string not found", () => {
	const str = EngineValue.string("hello");
	const search = EngineValue.string("xyz");
	const result = str.stringLastIndexOf(search, 2);
	expect(result).toBe(-1);
});

test("stringLastIndexOf finds substring at start", () => {
	const str = EngineValue.string("hello world");
	const search = EngineValue.string("hello");
	const result = str.stringLastIndexOf(search, 4);
	expect(result).toBe(0);
});

test("stringLastIndexOf handles single character strings", () => {
	const str = EngineValue.string("a");
	const search = EngineValue.string("a");
	const result = str.stringLastIndexOf(search, 0);
	expect(result).toBe(0);
});

test("stringLastIndexOf throws assertion error when fromIndex + searchLen > len", () => {
	const str = EngineValue.string("hello");
	const search = EngineValue.string("world");
	expect(() => str.stringLastIndexOf(search, 1)).toThrow(
		"Assertion failed: fromIndex + searchLen <= len",
	);
});

test("stringLastIndexOf handles empty search string", () => {
	const str = EngineValue.string("hello");
	const search = EngineValue.string("");
	const result = str.stringLastIndexOf(search, 5);
	expect(result).toBe(5);
});