import { expect, test } from "vitest";
import { EngineValue, WELL_KNOWN_SYMBOLS, EngineValueUtils } from "./data-types.ts";

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

test("create symbol without description", () => {
	expect(() => EngineValue.symbol()).not.toThrow();
});

test.for(["Symbol.iterator", "Symbol.toStringTag", "", "test"])(
	"create symbol with description: %s",
	(description) => {
		expect(() => EngineValue.symbol(description)).not.toThrow();
	},
);

test("assertIsSymbol passes for symbol value", () => {
	const value = EngineValue.symbol();
	expect(() => value.assertIsSymbol()).not.toThrow();
});

test.for([
	EngineValue.undefined(),
	EngineValue.null(),
	EngineValue.boolean(true),
	EngineValue.string("test"),
])("assertIsSymbol throws for non-symbol value", (value) => {
	expect(() => value.assertIsSymbol()).toThrow(
		"Can't call this operation on a non-symbol value.",
	);
});

test("asSymbol returns symbol value", () => {
	const value = EngineValue.symbol();
	const result = value.asSymbol();
	expect(result).toBe(value);
});

test.for([
	EngineValue.undefined(),
	EngineValue.null(),
	EngineValue.boolean(true),
	EngineValue.string("test"),
])("asSymbol throws for non-symbol value", (value) => {
	expect(() => value.asSymbol()).toThrow(
		"Can't call this operation on a non-symbol value.",
	);
});

test("WELL_KNOWN_SYMBOLS contains all expected symbols", () => {
	const expectedSymbols = [
		"%Symbol.asyncIterator%",
		"%Symbol.hasInstance%",
		"%Symbol.isConcatSpreadable%",
		"%Symbol.iterator%",
		"%Symbol.match%",
		"%Symbol.matchAll%",
		"%Symbol.replace%",
		"%Symbol.search%",
		"%Symbol.species%",
		"%Symbol.split%",
		"%Symbol.toPrimitive%",
		"%Symbol.toStringTag%",
		"%Symbol.unscopables%",
	];

	expect(Object.keys(WELL_KNOWN_SYMBOLS)).toEqual(expectedSymbols);
});

test("all well-known symbols are symbol type", () => {
	for (const symbol of Object.values(WELL_KNOWN_SYMBOLS)) {
		expect(() => symbol.assertIsSymbol()).not.toThrow();
	}
});

test("well-known symbols have correct descriptions", () => {
	expect(WELL_KNOWN_SYMBOLS["%Symbol.asyncIterator%"].data.description).toBe(
		"Symbol.asyncIterator",
	);
	expect(WELL_KNOWN_SYMBOLS["%Symbol.hasInstance%"].data.description).toBe(
		"Symbol.hasInstance",
	);
	expect(WELL_KNOWN_SYMBOLS["%Symbol.iterator%"].data.description).toBe(
		"Symbol.iterator",
	);
	expect(WELL_KNOWN_SYMBOLS["%Symbol.toStringTag%"].data.description).toBe(
		"Symbol.toStringTag",
	);
});

test("symbol without description has undefined description", () => {
	const symbol = EngineValue.symbol();
	expect(symbol.data.description).toBeUndefined();
});

test("symbol with description has correct description", () => {
	const description = "test.description";
	const symbol = EngineValue.symbol(description);
	expect(symbol.data.description).toBe(description);
});

test("create number value", () => {
	expect(() => EngineValue.number(42)).not.toThrow();
});

test.for([0, 42, -1.5, 3.14159, Infinity, -Infinity, NaN])(
	"create number value: %s",
	(value) => {
		const number = EngineValue.number(value);
		expect(number.data.value).toBe(value);
	},
);

test("create bigint value", () => {
	expect(() => EngineValue.bigint(42n)).not.toThrow();
});

test.for([0n, 42n, -1n, 12345678901234567890n])("create bigint value: %s", (value) => {
	const bigint = EngineValue.bigint(value);
	expect(bigint.data.value).toBe(value);
});

test("isNumber returns true for number values", () => {
	const number = EngineValue.number(42);
	expect(number.isNumber()).toBe(true);
});

test.for([
	EngineValue.undefined(),
	EngineValue.null(),
	EngineValue.boolean(true),
	EngineValue.string("test"),
	EngineValue.symbol("test"),
	EngineValue.bigint(42n),
])("isNumber returns false for non-number values", (value) => {
	expect(value.isNumber()).toBe(false);
});

test("isBigInt returns true for bigint values", () => {
	const bigint = EngineValue.bigint(42n);
	expect(bigint.isBigInt()).toBe(true);
});

test.for([
	EngineValue.undefined(),
	EngineValue.null(),
	EngineValue.boolean(true),
	EngineValue.string("test"),
	EngineValue.symbol("test"),
	EngineValue.number(42),
])("isBigInt returns false for non-bigint values", (value) => {
	expect(value.isBigInt()).toBe(false);
});

test("assertIsNumber passes for number value", () => {
	const number = EngineValue.number(42);
	expect(() => number.assertIsNumber()).not.toThrow();
});

test.for([
	EngineValue.undefined(),
	EngineValue.null(),
	EngineValue.boolean(true),
	EngineValue.string("test"),
	EngineValue.symbol("test"),
	EngineValue.bigint(42n),
])("assertIsNumber throws for non-number value", (value) => {
	expect(() => value.assertIsNumber()).toThrow(
		"Can't call this operation on a non-number value.",
	);
});

test("assertIsBigInt passes for bigint value", () => {
	const bigint = EngineValue.bigint(42n);
	expect(() => bigint.assertIsBigInt()).not.toThrow();
});

test.for([
	EngineValue.undefined(),
	EngineValue.null(),
	EngineValue.boolean(true),
	EngineValue.string("test"),
	EngineValue.symbol("test"),
	EngineValue.number(42),
])("assertIsBigInt throws for non-bigint value", (value) => {
	expect(() => value.assertIsBigInt()).toThrow(
		"Can't call this operation on a non-bigint value.",
	);
});

test("asNumber returns number value", () => {
	const number = EngineValue.number(42);
	const result = number.asNumber();
	expect(result).toBe(number);
});

test.for([
	EngineValue.undefined(),
	EngineValue.null(),
	EngineValue.boolean(true),
	EngineValue.string("test"),
	EngineValue.symbol("test"),
	EngineValue.bigint(42n),
])("asNumber throws for non-number value", (value) => {
	expect(() => value.asNumber()).toThrow(
		"Can't call this operation on a non-number value.",
	);
});

test("asBigInt returns bigint value", () => {
	const bigint = EngineValue.bigint(42n);
	const result = bigint.asBigInt();
	expect(result).toBe(bigint);
});

test.for([
	EngineValue.undefined(),
	EngineValue.null(),
	EngineValue.boolean(true),
	EngineValue.string("test"),
	EngineValue.symbol("test"),
	EngineValue.number(42),
])("asBigInt throws for non-bigint value", (value) => {
	expect(() => value.asBigInt()).toThrow(
		"Can't call this operation on a non-bigint value.",
	);
});

test("numberUnaryMinus negates positive numbers", () => {
	const number = EngineValue.number(42);
	const result = number.numberUnaryMinus();
	expect(result.data.value).toBe(-42);
});

test("numberUnaryMinus negates negative numbers", () => {
	const number = EngineValue.number(-42);
	const result = number.numberUnaryMinus();
	expect(result.data.value).toBe(42);
});

test("numberUnaryMinus returns NaN for NaN input", () => {
	const nan = EngineValue.number(NaN);
	const result = nan.numberUnaryMinus();
	expect(result.data.value).toBeNaN();
});

test("numberUnaryMinus handles Infinity correctly", () => {
	const infinity = EngineValue.number(Infinity);
	const result = infinity.numberUnaryMinus();
	expect(result.data.value).toBe(-Infinity);
});

test("numberUnaryMinus handles -Infinity correctly", () => {
	const negativeInfinity = EngineValue.number(-Infinity);
	const result = negativeInfinity.numberUnaryMinus();
	expect(result.data.value).toBe(Infinity);
});

test("numberUnaryMinus handles zero correctly", () => {
	const positiveZero = EngineValue.number(+0);
	const negativeZero = EngineValue.number(-0);

	const positiveResult = positiveZero.numberUnaryMinus();
	const negativeResult = negativeZero.numberUnaryMinus();

	expect(positiveResult.data.value).toBe(-0);
	expect(negativeResult.data.value).toBe(0);
});

test.for([
	{ input: 0, expected: -1 },
	{ input: 1, expected: -2 },
	{ input: -1, expected: 0 },
	{ input: 42, expected: -43 },
	{ input: -42, expected: 41 },
])("numberBitwiseNot(~$input) = $expected", ({ input, expected }) => {
	const number = EngineValue.number(input);
	const result = number.numberBitwiseNot();
	expect(result.data.value).toBe(expected);
});

test.for([
	{ input: 2147483647, expected: -2147483648 }, // 2^31 - 1
	{ input: -2147483648, expected: 2147483647 }, // -2^31
	// { input: 4294967295, expected: 0 }, // 2^32 - 1
	{ input: 4294967296, expected: -1 }, // 2^32
])("numberBitwiseNot handles 32-bit overflow for $input", ({ input, expected }) => {
	const number = EngineValue.number(input);
	const result = number.numberBitwiseNot();
	expect(result.data.value).toBe(expected);
});

test.for([
	{ input: 3.14, expected: -4 },
	// { input: -3.14, expected: 3 },
	{ input: 42.9, expected: -43 },
	{ input: -42.9, expected: 41 },
])("numberBitwiseNot floors $input before operation", ({ input, expected }) => {
	const number = EngineValue.number(input);
	const result = number.numberBitwiseNot();
	expect(result.data.value).toBe(expected);
});

test.for([
	{ base: 2, exponent: 3, expected: 8 },
	{ base: 4, exponent: 0.5, expected: 2 },
	{ base: 10, exponent: 2, expected: 100 },
	{ base: 5, exponent: -1, expected: 0.2 },
])("$base ^ $exponent = $expected", ({ base, exponent, expected }) => {
	const baseValue = EngineValue.number(base);
	const exponentValue = EngineValue.number(exponent);
	const result = baseValue.numberExponentiate(exponentValue);
	expect(result.data.value).toBe(expected);
});

test("numberExponentiate handles NaN exponent", () => {
	const base = EngineValue.number(42);
	const nanExponent = EngineValue.number(NaN);
	const result = base.numberExponentiate(nanExponent);
	expect(result.data.value).toBeNaN();
});

test.for([42, -42, 0, Infinity, -Infinity])("any base ^ 0 = 1", (baseValue) => {
	const base = EngineValue.number(baseValue);
	const zeroExponent = EngineValue.number(0);
	const result = base.numberExponentiate(zeroExponent);
	expect(result.data.value).toBe(1);
});

test("numberExponentiate handles NaN base", () => {
	const nanBase = EngineValue.number(NaN);
	const exponent = EngineValue.number(2);
	const result = nanBase.numberExponentiate(exponent);
	expect(result.data.value).toBeNaN();
});

test("numberExponentiate handles Infinity base with an positive exponent", () => {
	const infinity = EngineValue.number(Infinity);
	const positiveExponent = EngineValue.number(2);
	const result = infinity.numberExponentiate(positiveExponent);
	expect(result.data.value).toBe(Infinity);
});

test("numberExponentiate handles Infinity base with an negative exponent", () => {
	const infinity = EngineValue.number(Infinity);
	const negativeExponent = EngineValue.number(-2);
	const result = infinity.numberExponentiate(negativeExponent);
	expect(result.data.value).toBe(0);
});

test("numberExponentiate handles -Infinity base with odd positive exponent", () => {
	const negativeInfinity = EngineValue.number(-Infinity);
	const oddExponent = EngineValue.number(3);
	const result = negativeInfinity.numberExponentiate(oddExponent);
	expect(result.data.value).toBe(-Infinity);
});

test("numberExponentiate handles -Infinity base with even positive exponent", () => {
	const negativeInfinity = EngineValue.number(-Infinity);
	const evenExponent = EngineValue.number(2);
	const result = negativeInfinity.numberExponentiate(evenExponent);
	expect(result.data.value).toBe(Infinity);
});

test("numberExponentiate handles zero base with an positive exponent", () => {
	const zero = EngineValue.number(0);
	const positiveExponent = EngineValue.number(2);
	const result = zero.numberExponentiate(positiveExponent);
	expect(result.data.value).toBe(0);
});

test("numberExponentiate handles zero base with an negative exponent", () => {
	const zero = EngineValue.number(0);
	const negativeExponent = EngineValue.number(-2);
	const result = zero.numberExponentiate(negativeExponent);
	expect(result.data.value).toBe(Infinity);
});

test("numberExponentiate handles -0 base with even negative exponent", () => {
	const negativeZero = EngineValue.number(-0);
	const evenExponent = EngineValue.number(-2);
	const result = negativeZero.numberExponentiate(evenExponent);
	expect(result.data.value).toBe(Infinity);
});

test("numberExponentiate handles Infinity exponent with base > 1", () => {
	const base = EngineValue.number(2);
	const infinityExponent = EngineValue.number(Infinity);
	const result = base.numberExponentiate(infinityExponent);
	expect(result.data.value).toBe(Infinity);
});

test("numberExponentiate handles Infinity exponent with base = 1", () => {
	const base = EngineValue.number(1);
	const infinityExponent = EngineValue.number(Infinity);
	const result = base.numberExponentiate(infinityExponent);
	expect(result.data.value).toBeNaN();
});

test("numberExponentiate handles Infinity exponent with base < 1", () => {
	const base = EngineValue.number(0.5);
	const infinityExponent = EngineValue.number(Infinity);
	const result = base.numberExponentiate(infinityExponent);
	expect(result.data.value).toBe(0);
});

test("numberExponentiate handles -Infinity exponent with base > 1", () => {
	const base = EngineValue.number(2);
	const negativeInfinityExponent = EngineValue.number(-Infinity);
	const result = base.numberExponentiate(negativeInfinityExponent);
	expect(result.data.value).toBe(0);
});

test("numberExponentiate handles -Infinity exponent with base = 1", () => {
	const base = EngineValue.number(1);
	const negativeInfinityExponent = EngineValue.number(-Infinity);
	const result = base.numberExponentiate(negativeInfinityExponent);
	expect(result.data.value).toBeNaN();
});

test("numberExponentiate handles -Infinity exponent with base < 1", () => {
	const base = EngineValue.number(0.5);
	const negativeInfinityExponent = EngineValue.number(-Infinity);
	const result = base.numberExponentiate(negativeInfinityExponent);
	expect(result.data.value).toBe(Infinity);
});

test("EngineValueUtils.isPositiveOrNegativeZero returns true for positive zero", () => {
	const positiveZero = EngineValue.number(+0);
	expect(EngineValueUtils.isPositiveOrNegativeZero(positiveZero)).toBe(true);
});

test("EngineValueUtils.isPositiveOrNegativeZero returns true for negative zero", () => {
	const negativeZero = EngineValue.number(-0);
	expect(EngineValueUtils.isPositiveOrNegativeZero(negativeZero)).toBe(true);
});

test("EngineValueUtils.isPositiveOrNegativeZero returns true for raw positive zero", () => {
	expect(EngineValueUtils.isPositiveOrNegativeZero(+0)).toBe(true);
});

test("EngineValueUtils.isPositiveOrNegativeZero returns true for raw negative zero", () => {
	expect(EngineValueUtils.isPositiveOrNegativeZero(-0)).toBe(true);
});

test.for([1, -1, 0.1, -0.1, 42, -42, Infinity, -Infinity, NaN])(
	"isPositiveOrNegativeZero returns false for %s",
	(value) => {
		expect(EngineValueUtils.isPositiveOrNegativeZero(value)).toBe(false);
	},
);

test.for([1, -1, 0.1, -0.1, 42, -42, Infinity, -Infinity, NaN])(
	"isPositiveOrNegativeZero returns false for EngineValue(%s)",
	(value) => {
		const engineValue = EngineValue.number(value);
		expect(EngineValueUtils.isPositiveOrNegativeZero(engineValue)).toBe(false);
	},
);

test("EngineValueUtils.isNegativeZero returns true for negative zero", () => {
	const negativeZero = EngineValue.number(-0);
	expect(EngineValueUtils.isNegativeZero(negativeZero)).toBe(true);
});

test("EngineValueUtils.isNegativeZero returns true for raw negative zero", () => {
	expect(EngineValueUtils.isNegativeZero(-0)).toBe(true);
});

test("EngineValueUtils.isNegativeZero returns false for positive zero", () => {
	const positiveZero = EngineValue.number(+0);
	expect(EngineValueUtils.isNegativeZero(positiveZero)).toBe(false);
});

test("EngineValueUtils.isNegativeZero returns false for raw positive zero", () => {
	expect(EngineValueUtils.isNegativeZero(+0)).toBe(false);
});

test.for([1, -1, 0.1, -0.1, 42, -42, Infinity, -Infinity, NaN])(
	"isNegativeZero returns false for %s",
	(value) => {
		expect(EngineValueUtils.isNegativeZero(value)).toBe(false);
	},
);

test.for([1, -1, 0.1, -0.1, 42, -42, Infinity, -Infinity, NaN])(
	"isNegativeZero returns false for EngineValue(%s)",
	(value) => {
		const engineValue = EngineValue.number(value);
		expect(EngineValueUtils.isNegativeZero(engineValue)).toBe(false);
	},
);

test.for([
	{ x: 2, y: 3, expected: 6 },
	{ x: -2, y: 3, expected: -6 },
	{ x: 2, y: -3, expected: -6 },
	{ x: -2, y: -3, expected: 6 },
	{ x: 0, y: 5, expected: 0 },
	{ x: 5, y: 0, expected: 0 },
	{ x: 1.5, y: 2, expected: 3 },
	{ x: -1.5, y: 2, expected: -3 },
	{ x: 1.5, y: -2, expected: -3 },
])("$x * $y = $expected", ({ x, y, expected }) => {
	const xValue = EngineValue.number(x);
	const yValue = EngineValue.number(y);
	const result = xValue.numberMultiply(yValue);
	expect(result.data.value).toBe(expected);
});

test("numberMultiply returns NaN when either operand is NaN", () => {
	const nan = EngineValue.number(NaN);
	const normal = EngineValue.number(42);

	expect(nan.numberMultiply(normal).data.value).toBeNaN();
	expect(normal.numberMultiply(nan).data.value).toBeNaN();
	expect(nan.numberMultiply(nan).data.value).toBeNaN();
});

test("numberMultiply handles Infinity * zero = NaN", () => {
	const infinity = EngineValue.number(Infinity);
	const positiveZero = EngineValue.number(+0);
	const negativeZero = EngineValue.number(-0);

	expect(infinity.numberMultiply(positiveZero).data.value).toBeNaN();
	expect(infinity.numberMultiply(negativeZero).data.value).toBeNaN();
	expect(EngineValue.number(-Infinity).numberMultiply(positiveZero).data.value).toBeNaN();
	expect(EngineValue.number(-Infinity).numberMultiply(negativeZero).data.value).toBeNaN();
});

test.for([
	{ infinity: Infinity, positive: 5, expected: Infinity },
	{ infinity: -Infinity, positive: 5, expected: -Infinity },
])("$infinity * $positive = $expected", ({ infinity, positive, expected }) => {
	const infinityValue = EngineValue.number(infinity);
	const positiveValue = EngineValue.number(positive);
	const result = infinityValue.numberMultiply(positiveValue);
	expect(result.data.value).toBe(expected);
});

test.for([
	{ x: -0, y: -0, expected: +0 },
	{ x: -0, y: -5, expected: +0 },
	{ x: -0, y: 5, expected: -0 },
	{ x: -0, y: 0, expected: -0 },
])("$x * $y = $expected (negative zero edge cases)", ({ x, y, expected }) => {
	const xValue = EngineValue.number(x);
	const yValue = EngineValue.number(y);
	const result = xValue.numberMultiply(yValue);
	expect(Object.is(result.data.value, expected)).toBe(true);
});

test.for([
	{ x: 0, y: -0, expected: -0 },
	{ x: 5, y: -0, expected: -0 },
])("$x * $y = $expected (negative zero as second operand)", ({ x, y, expected }) => {
	const xValue = EngineValue.number(x);
	const yValue = EngineValue.number(y);
	const result = xValue.numberMultiply(yValue);
	expect(Object.is(result.data.value, expected)).toBe(true);
});

test.for([
	{ x: 6, y: 3, expected: 2 },
	{ x: -6, y: 3, expected: -2 },
	{ x: 6, y: -3, expected: -2 },
	{ x: -6, y: -3, expected: 2 },
	{ x: 0, y: 5, expected: 0 },
	{ x: 5, y: 2, expected: 2.5 },
	{ x: -5, y: 2, expected: -2.5 },
	{ x: 5, y: -2, expected: -2.5 },
	{ x: -5, y: -2, expected: 2.5 },
])("$x / $y = $expected", ({ x, y, expected }) => {
	const xValue = EngineValue.number(x);
	const yValue = EngineValue.number(y);
	const result = xValue.numberDivide(yValue);
	expect(result.data.value).toBe(expected);
});

test("numberDivide returns NaN when either operand is NaN", () => {
	const nan = EngineValue.number(NaN);
	const normal = EngineValue.number(42);

	expect(nan.numberDivide(normal).data.value).toBeNaN();
	expect(normal.numberDivide(nan).data.value).toBeNaN();
	expect(nan.numberDivide(nan).data.value).toBeNaN();
});

test("numberDivide handles Infinity / Infinity = NaN", () => {
	const infinity = EngineValue.number(Infinity);
	const negativeInfinity = EngineValue.number(-Infinity);

	expect(infinity.numberDivide(infinity).data.value).toBeNaN();
	expect(infinity.numberDivide(negativeInfinity).data.value).toBeNaN();
	expect(negativeInfinity.numberDivide(infinity).data.value).toBeNaN();
	expect(negativeInfinity.numberDivide(negativeInfinity).data.value).toBeNaN();
});

test.for([
	{ infinity: Infinity, positive: 5, expected: Infinity },
	{ infinity: -Infinity, positive: 5, expected: -Infinity },
])("$infinity / $positive = $expected", ({ infinity, positive, expected }) => {
	const infinityValue = EngineValue.number(infinity);
	const positiveValue = EngineValue.number(positive);
	const result = infinityValue.numberDivide(positiveValue);
	expect(result.data.value).toBe(expected);
});

test.for([
	{ x: 5, y: Infinity, expected: +0 },
	{ x: -5, y: Infinity, expected: -0 },
	{ x: 5, y: -Infinity, expected: -0 },
	{ x: -5, y: -Infinity, expected: +0 },
])("$x / $y = $expected (division by infinity)", ({ x, y, expected }) => {
	const xValue = EngineValue.number(x);
	const yValue = EngineValue.number(y);
	const result = xValue.numberDivide(yValue);
	expect(Object.is(result.data.value, expected)).toBe(true);
});

test("numberDivide handles zero / zero = NaN", () => {
	const positiveZero = EngineValue.number(+0);
	const negativeZero = EngineValue.number(-0);

	expect(positiveZero.numberDivide(positiveZero).data.value).toBeNaN();
	expect(positiveZero.numberDivide(negativeZero).data.value).toBeNaN();
	expect(negativeZero.numberDivide(positiveZero).data.value).toBeNaN();
	expect(negativeZero.numberDivide(negativeZero).data.value).toBeNaN();
});

test.for([
	{ x: 5, y: 0, expected: Infinity },
	{ x: -5, y: 0, expected: -Infinity },
	{ x: 0, y: 5, expected: 0 },
])("$x / $y = $expected (division by zero edge cases)", ({ x, y, expected }) => {
	const xValue = EngineValue.number(x);
	const yValue = EngineValue.number(y);
	const result = xValue.numberDivide(yValue);
	expect(result.data.value).toBe(expected);
});

test.for([
	{ x: 5, y: -0, expected: -Infinity },
	{ x: -5, y: -0, expected: Infinity },
])("$x / $y = $expected (division by negative zero)", ({ x, y, expected }) => {
	const xValue = EngineValue.number(x);
	const yValue = EngineValue.number(y);
	const result = xValue.numberDivide(yValue);
	expect(result.data.value).toBe(expected);
});

test.for([
	{ x: +0, y: -5, expected: -0 },
	{ x: +0, y: 5, expected: +0 },
	{ x: -0, y: -5, expected: +0 },
	{ x: -0, y: 5, expected: -0 },
])("$x / $y = $expected (zero division edge cases)", ({ x, y, expected }) => {
	const xValue = EngineValue.number(x);
	const yValue = EngineValue.number(y);
	const result = xValue.numberDivide(yValue);

	expect(
		Object.is(result.data.value, expected),
		`${result.data.value}, ${expected}`,
	).toBe(true);
});
