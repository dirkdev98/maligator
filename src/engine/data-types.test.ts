import { expect, test } from "vitest";
import { EngineValue, EngineValueUtils, WELL_KNOWN_SYMBOLS } from "./data-types.ts";

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
