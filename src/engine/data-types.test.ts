import { expect, test } from "vitest";
import { EngineValue } from "./data-types.ts";

test("create undefined", () => {
	expect(() => EngineValue.undefined()).not.toThrow();
});

test("create null", () => {
	expect(() => EngineValue.null()).not.toThrow();
});

test.for([true, false])("create boolean value: %s", (value) => {
	expect(() => EngineValue.boolean(value)).not.toThrow();
});

test.for(["", "hello", "world", "test"])("create string value: %s", (value) => {
	expect(() => EngineValue.string(value)).not.toThrow();
});

test("assertIsUndefined passes for undefined value", () => {
	const value = EngineValue.undefined();
	expect(() => value.assertIsUndefined()).not.toThrow();
});

test.for([EngineValue.null(), EngineValue.boolean(true), EngineValue.string("test")])(
	"assertIsUndefined throws for non-undefined value",
	(value) => {
		expect(() => value.assertIsUndefined()).toThrow(
			"Can't call this operation on a non-undefined value.",
		);
	},
);

test("assertIsNull passes for null value", () => {
	const value = EngineValue.null();
	expect(() => value.assertIsNull()).not.toThrow();
});

test.for([
	EngineValue.undefined(),
	EngineValue.boolean(true),
	EngineValue.string("test"),
])("assertIsNull throws for non-null value", (value) => {
	expect(() => value.assertIsNull()).toThrow(
		"Can't call this operation on a non-null value.",
	);
});

test.for([true, false])("assertIsBoolean passes for boolean value: %s", (value) => {
	const boolValue = EngineValue.boolean(value);
	expect(() => boolValue.assertIsBoolean()).not.toThrow();
});

test.for([EngineValue.undefined(), EngineValue.null(), EngineValue.string("test")])(
	"assertIsBoolean throws for non-boolean value",
	(value) => {
		expect(() => value.assertIsBoolean()).toThrow(
			"Can't call this operation on a non-boolean value.",
		);
	},
);

test.for(["", "hello", "world"])(
	"assertIsString passes for string value: %s",
	(value) => {
		const stringValue = EngineValue.string(value);
		expect(() => stringValue.assertIsString()).not.toThrow();
	},
);

test.for([EngineValue.undefined(), EngineValue.null(), EngineValue.boolean(true)])(
	"assertIsString throws for non-string value",
	(value) => {
		expect(() => value.assertIsString()).toThrow(
			"Can't call this operation on a non-string value.",
		);
	},
);

test("asUndefined returns undefined value", () => {
	const value = EngineValue.undefined();
	const result = value.asUndefined();
	expect(result).toBe(value);
});

test.for([EngineValue.null(), EngineValue.boolean(true), EngineValue.string("test")])(
	"asUndefined throws for non-undefined value",
	(value) => {
		expect(() => value.asUndefined()).toThrow(
			"Can't call this operation on a non-undefined value.",
		);
	},
);

test("asNull returns null value", () => {
	const value = EngineValue.null();
	const result = value.asNull();
	expect(result).toBe(value);
});

test.for([
	EngineValue.undefined(),
	EngineValue.boolean(true),
	EngineValue.string("test"),
])("asNull throws for non-null value", (value) => {
	expect(() => value.asNull()).toThrow("Can't call this operation on a non-null value.");
});

test.for([true, false])("asBoolean returns boolean value: %s", (value) => {
	const boolValue = EngineValue.boolean(value);
	const result = boolValue.asBoolean();
	expect(result).toBe(boolValue);
});

test.for([EngineValue.undefined(), EngineValue.null(), EngineValue.string("test")])(
	"asBoolean throws for non-boolean value",
	(value) => {
		expect(() => value.asBoolean()).toThrow(
			"Can't call this operation on a non-boolean value.",
		);
	},
);

test.for(["", "hello", "world"])("asString returns string value: %s", (value) => {
	const stringValue = EngineValue.string(value);
	const result = stringValue.asString();
	expect(result).toBe(stringValue);
});

test.for([EngineValue.undefined(), EngineValue.null(), EngineValue.boolean(true)])(
	"asString throws for non-string value",
	(value) => {
		expect(() => value.asString()).toThrow(
			"Can't call this operation on a non-string value.",
		);
	},
);

test.for([0, 1, 3, 5])(
	"stringIndexOf returns fromIndex when search string is empty, fromIndex: %s",
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
