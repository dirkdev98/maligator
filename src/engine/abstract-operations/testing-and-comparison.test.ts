import { expect, test } from "vitest";
import { normalCompletion } from "../types-and-values/completion-record.ts";
import { EngineValue } from "../types-and-values/data-types.ts";
import {
	requireObjectCoercible,
	UNUSED,
	isArray,
	isCallable,
	isConstructor,
	isExtensible,
	sameType,
	sameTypeWrapped,
	sameValue,
	sameValueWrapped,
	sameValueZero,
	sameValueZeroWrapped,
	sameValueNonNumber,
	sameValueNonNumberWrapped,
	isLessThan,
	isLooselyEqual,
	isStrictlyEqual,
} from "./testing-and-comparison.ts";

test.for([
	{ type: "undefined", value: EngineValue.undefined() },
	{ type: "null", value: EngineValue.null() },
])("requireObjectCoercible throws TypeError for $type", ({ value }) => {
	const result = requireObjectCoercible(value);

	expect(result.type).toBe("throw");
	if (result.type === "throw") {
		expect(result.error).toBeInstanceOf(TypeError);
		expect(result.error.message).toBe("Argument can't be converted to an object.");
	}
});

test.for([
	{ type: "object", value: EngineValue.object([]) },
	{ type: "string", value: EngineValue.string("hello") },
	{ type: "number", value: EngineValue.number(42) },
	{ type: "boolean", value: EngineValue.boolean(true) },
	{ type: "symbol", value: EngineValue.symbol("test") },
	{ type: "bigint", value: EngineValue.bigint(42n) },
])("requireObjectCoercible returns UNUSED for $type", ({ value }) => {
	const result = requireObjectCoercible(value);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value).toBe(UNUSED);
	}
});

test.for([
	{ type: "undefined", value: EngineValue.undefined() },
	{ type: "null", value: EngineValue.null() },
	{ type: "boolean", value: EngineValue.boolean(true) },
	{ type: "string", value: EngineValue.string("hello") },
	{ type: "number", value: EngineValue.number(42) },
	{ type: "symbol", value: EngineValue.symbol("test") },
	{ type: "bigint", value: EngineValue.bigint(42n) },
])("isArray returns false for non-array $type", ({ value }) => {
	const result = isArray(value);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.data.value).toBe(false);
	}
});

test.for([
	{ type: "undefined", value: EngineValue.undefined() },
	{ type: "null", value: EngineValue.null() },
	{ type: "boolean", value: EngineValue.boolean(true) },
	{ type: "string", value: EngineValue.string("hello") },
	{ type: "number", value: EngineValue.number(42) },
	{ type: "symbol", value: EngineValue.symbol("test") },
	{ type: "bigint", value: EngineValue.bigint(42n) },
])("isCallable returns false for non-callable $type", ({ value }) => {
	expect(isCallable(value).data.value).toBe(false);
});

test("isCallable returns true for object with Call internal slot", () => {
	const argument = EngineValue.object([]);
	argument.objectSetInternalSlot("Call", EngineValue.undefined());

	const result = isCallable(argument);

	expect(result.data.value).toBe(true);
});

test("isCallable returns false for object without Call internal slot", () => {
	const argument = EngineValue.object([]);

	const result = isCallable(argument);

	expect(result.data.value).toBe(false);
});

test.for([
	{ type: "undefined", value: EngineValue.undefined() },
	{ type: "null", value: EngineValue.null() },
	{ type: "boolean", value: EngineValue.boolean(true) },
	{ type: "string", value: EngineValue.string("hello") },
	{ type: "number", value: EngineValue.number(42) },
	{ type: "symbol", value: EngineValue.symbol("test") },
	{ type: "bigint", value: EngineValue.bigint(42n) },
])("isConstructor returns false for non-constructor $type", ({ value }) => {
	expect(isConstructor(value).data.value).toBe(false);
});

test("isConstructor returns true for object with Construct internal slot", () => {
	const argument = EngineValue.object([]);
	argument.objectSetInternalSlot("Construct", EngineValue.undefined());

	const result = isConstructor(argument);

	expect(result.data.value).toBe(true);
});

test("isConstructor returns false for object without Construct internal slot", () => {
	const argument = EngineValue.object([]);

	const result = isConstructor(argument);

	expect(result.data.value).toBe(false);
});

test.for([
	{ extensible: true, expected: true },
	{ extensible: false, expected: false },
])(
	"isExtensible returns $expected for object with extensible=$extensible",
	({ extensible, expected }) => {
		const obj = EngineValue.object([]);
		obj.objectSetInternalSlot("IsExtensible", () => {
			return normalCompletion(EngineValue.boolean(extensible));
		});

		const result = isExtensible(obj);

		expect(result.type).toBe("normal");
		if (result.type === "normal") {
			expect(result.value.data.value).toBe(expected);
		}
	},
);

test.for([
	{ x: EngineValue.undefined(), y: EngineValue.undefined() },
	{ x: EngineValue.null(), y: EngineValue.null() },
	{ x: EngineValue.boolean(true), y: EngineValue.boolean(false) },
	{ x: EngineValue.string("hello"), y: EngineValue.string("world") },
	{ x: EngineValue.number(42), y: EngineValue.number(-10) },
	{ x: EngineValue.bigint(42n), y: EngineValue.bigint(-100n) },
	{ x: EngineValue.symbol("test"), y: EngineValue.symbol("other") },
	{ x: EngineValue.object([]), y: EngineValue.object([]) },
])("sameType returns true for matching $type types", ({ x, y }) => {
	const result = sameType(x, y);

	expect(result).toBe(true);
});

test.for([
	{ x: EngineValue.undefined(), y: EngineValue.null() },
	{ x: EngineValue.boolean(true), y: EngineValue.string("true") },
	{ x: EngineValue.number(42), y: EngineValue.bigint(42n) },
	{ x: EngineValue.string("42"), y: EngineValue.number(42) },
	{ x: EngineValue.object([]), y: EngineValue.null() },
])("sameType returns false for different $type and $type types", ({ x, y }) => {
	const result = sameType(x, y);

	expect(result).toBe(false);
});

test.for([
	{ x: EngineValue.number(42), y: EngineValue.number(-10), expected: true },
	{ x: EngineValue.number(42), y: EngineValue.string("42"), expected: false },
])("sameTypeWrapped returns $expected for types", ({ x, y, expected }) => {
	const result = sameTypeWrapped(x, y);

	expect(result.isBoolean()).toBe(true);
	expect(result.data.value).toBe(expected);
});

test.for([
	{ x: 42, y: 42, expected: true },
	{ x: NaN, y: NaN, expected: true },
	{ x: 0, y: -0, expected: false },
	{ x: -0, y: 0, expected: false },
	{ x: 42, y: 100, expected: false },
	{ x: NaN, y: 42, expected: false },
])("sameValue handles number edge cases: $x vs $y", ({ x, y, expected }) => {
	expect(sameValue(EngineValue.number(x), EngineValue.number(y))).toBe(expected);
});

test.for([
	{ x: EngineValue.undefined(), y: EngineValue.undefined(), expected: true },
	{ x: EngineValue.null(), y: EngineValue.null(), expected: true },
	{ x: EngineValue.bigint(42n), y: EngineValue.bigint(42n), expected: true },
	{ x: EngineValue.bigint(42n), y: EngineValue.bigint(100n), expected: false },
	{ x: EngineValue.string("hello"), y: EngineValue.string("hello"), expected: true },
	{ x: EngineValue.string("hello"), y: EngineValue.string("world"), expected: false },
	{ x: EngineValue.boolean(true), y: EngineValue.boolean(true), expected: true },
	{ x: EngineValue.boolean(true), y: EngineValue.boolean(false), expected: false },
])("sameValue handles non-number types: $expected", ({ x, y, expected }) => {
	expect(sameValue(x, y)).toBe(expected);
});

test("sameValue returns true for same object reference", () => {
	const obj = EngineValue.object([]);
	expect(sameValue(obj, obj)).toBe(true);
});

test("sameValue returns false for different object references", () => {
	expect(sameValue(EngineValue.object([]), EngineValue.object([]))).toBe(false);
});

test.for([
	{ x: EngineValue.number(42), y: EngineValue.string("42") },
	{ x: EngineValue.bigint(42n), y: EngineValue.number(42) },
])("sameValue returns false for different types", ({ x, y }) => {
	expect(sameValue(x, y)).toBe(false);
});

test("sameValueWrapped returns EngineValue<boolean>", () => {
	const x = EngineValue.number(42);
	const y = EngineValue.number(42);

	const result = sameValueWrapped(x, y);

	expect(result.isBoolean()).toBe(true);
	expect(result.data.value).toBe(true);
});

test.for([
	{ x: 42, y: 42, expected: true },
	{ x: NaN, y: NaN, expected: true },
	{ x: 0, y: -0, expected: true },
	{ x: -0, y: 0, expected: true },
	{ x: 42, y: 100, expected: false },
	{ x: NaN, y: 42, expected: false },
])("sameValueZero handles number edge cases: $x vs $y", ({ x, y, expected }) => {
	expect(sameValueZero(EngineValue.number(x), EngineValue.number(y))).toBe(expected);
});

test.for([
	{ x: EngineValue.undefined(), y: EngineValue.undefined(), expected: true },
	{ x: EngineValue.null(), y: EngineValue.null(), expected: true },
	{ x: EngineValue.bigint(42n), y: EngineValue.bigint(42n), expected: true },
	{ x: EngineValue.string("hello"), y: EngineValue.string("hello"), expected: true },
	{ x: EngineValue.number(42), y: EngineValue.string("42"), expected: false },
])("sameValueZero handles non-number types", ({ x, y, expected }) => {
	expect(sameValueZero(x, y)).toBe(expected);
});

test("sameValueZeroWrapped returns EngineValue<boolean>", () => {
	const x = EngineValue.number(42);
	const y = EngineValue.number(42);

	const result = sameValueZeroWrapped(x, y);

	expect(result.isBoolean()).toBe(true);
	expect(result.data.value).toBe(true);
});

test.for([
	{ x: EngineValue.undefined(), y: EngineValue.undefined(), expected: true },
	{ x: EngineValue.null(), y: EngineValue.null(), expected: true },
	{ x: EngineValue.bigint(42n), y: EngineValue.bigint(42n), expected: true },
	{ x: EngineValue.bigint(42n), y: EngineValue.bigint(100n), expected: false },
	{ x: EngineValue.string("hello"), y: EngineValue.string("hello"), expected: true },
	{ x: EngineValue.string("hello"), y: EngineValue.string("world"), expected: false },
	{ x: EngineValue.boolean(true), y: EngineValue.boolean(true), expected: true },
	{ x: EngineValue.boolean(true), y: EngineValue.boolean(false), expected: false },
])("sameValueNonNumber handles $expected for non-numbers", ({ x, y, expected }) => {
	expect(sameValueNonNumber(x, y)).toBe(expected);
});

test("sameValueNonNumber returns true for same object reference", () => {
	const obj = EngineValue.object([]);
	expect(sameValueNonNumber(obj, obj)).toBe(true);
});

test("sameValueNonNumber returns false for different object references", () => {
	expect(sameValueNonNumber(EngineValue.object([]), EngineValue.object([]))).toBe(false);
});

test.for([
	{ x: EngineValue.string("hello"), y: EngineValue.number(42) },
	{ x: EngineValue.bigint(42n), y: EngineValue.number(42) },
])("sameValueNonNumber returns false for different types", ({ x, y }) => {
	expect(sameValueNonNumber(x, y)).toBe(false);
});

test("sameValueNonNumberWrapped returns EngineValue<boolean>", () => {
	const x = EngineValue.bigint(42n);
	const y = EngineValue.bigint(42n);

	const result = sameValueNonNumberWrapped(x, y);

	expect(result.isBoolean()).toBe(true);
	expect(result.data.value).toBe(true);
});

test.skip.for([
	{ x: EngineValue.string("a"), y: EngineValue.string("b") },
	{ x: EngineValue.string("A"), y: EngineValue.string("Z") },
	{ x: EngineValue.string("0"), y: EngineValue.string("9") },
])("isLessThan returns true for string comparisons: '$x' < '$y'", ({ x, y }) => {
	const result = isLessThan(x, y);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.isBoolean()).toBe(true);
		if (result.value.isBoolean()) {
			expect(result.value.data.value).toBe(true);
		}
	}
});

test.skip.for([
	{ x: EngineValue.string("b"), y: EngineValue.string("a") },
	{ x: EngineValue.string("Z"), y: EngineValue.string("A") },
	{ x: EngineValue.string("9"), y: EngineValue.string("0") },
])("isLessThan returns false for string comparisons: '$x' > '$y'", ({ x, y }) => {
	const result = isLessThan(x, y);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.isBoolean()).toBe(true);
		if (result.value.isBoolean()) {
			expect(result.value.data.value).toBe(false);
		}
	}
});

test.skip("isLessThan compares strings lexicographically by character", () => {
	const x = EngineValue.string("aa");
	const y = EngineValue.string("ab");

	const result = isLessThan(x, y);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.isBoolean()).toBe(true);
		if (result.value.isBoolean()) {
			expect(result.value.data.value).toBe(true);
		}
	}
});

test.skip("isLessThan returns true for shorter string that is prefix of longer string", () => {
	const x = EngineValue.string("abc");
	const y = EngineValue.string("abcd");

	const result = isLessThan(x, y);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.isBoolean()).toBe(true);
		if (result.value.isBoolean()) {
			expect(result.value.data.value).toBe(true);
		}
	}
});

test.skip("isLessThan returns false for equal strings", () => {
	const x = EngineValue.string("hello");
	const y = EngineValue.string("hello");

	const result = isLessThan(x, y);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.isBoolean()).toBe(true);
		if (result.value.isBoolean()) {
			expect(result.value.data.value).toBe(false);
		}
	}
});

test.skip("isLessThan uses Unicode code point order for strings", () => {
	const x = EngineValue.string("Z");
	const y = EngineValue.string("a");

	const result = isLessThan(x, y);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.isBoolean()).toBe(true);
		if (result.value.isBoolean()) {
			expect(result.value.data.value).toBe(true);
		}
	}
});

test.skip("isLessThan returns true for BigInt < String (numeric)", () => {
	const x = EngineValue.bigint(42n);
	const y = EngineValue.string("100");

	const result = isLessThan(x, y);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.isBoolean()).toBe(true);
		if (result.value.isBoolean()) {
			expect(result.value.data.value).toBe(true);
		}
	}
});

test.skip("isLessThan returns false for BigInt > String (numeric)", () => {
	const x = EngineValue.bigint(100n);
	const y = EngineValue.string("42");

	const result = isLessThan(x, y);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.isBoolean()).toBe(true);
		if (result.value.isBoolean()) {
			expect(result.value.data.value).toBe(false);
		}
	}
});

test.skip("isLessThan returns false for BigInt = String (numeric)", () => {
	const x = EngineValue.bigint(42n);
	const y = EngineValue.string("42");

	const result = isLessThan(x, y);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.isBoolean()).toBe(true);
		if (result.value.isBoolean()) {
			expect(result.value.data.value).toBe(false);
		}
	}
});

test.skip.for([
	{ x: EngineValue.bigint(42n), y: EngineValue.string("abc") },
	{ x: EngineValue.bigint(42n), y: EngineValue.string("42abc") },
])(
	"isLessThan returns undefined for BigInt $x < String $y (non-numeric string)",
	({ x, y }) => {
		const result = isLessThan(x, y);

		expect(result.type).toBe("normal");
		if (result.type === "normal") {
			expect(result.value.isUndefined()).toBe(true);
		}
	},
);

test.skip("isLessThan returns true for String < BigInt (numeric)", () => {
	const x = EngineValue.string("42");
	const y = EngineValue.bigint(100n);

	const result = isLessThan(x, y);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.isBoolean()).toBe(true);
		if (result.value.isBoolean()) {
			expect(result.value.data.value).toBe(true);
		}
	}
});

test.skip.for([
	{ x: EngineValue.string("abc"), y: EngineValue.bigint(42n) },
	{ x: EngineValue.string("42abc"), y: EngineValue.bigint(42n) },
])(
	"isLessThan returns undefined for String < BigInt (non-numeric string)",
	({ x, y }) => {
		const result = isLessThan(x, y);

		expect(result.type).toBe("normal");
		if (result.type === "normal") {
			expect(result.value.isUndefined()).toBe(true);
		}
	},
);

test.skip.for([
	{ x: EngineValue.number(42), y: EngineValue.number(100) },
	{ x: EngineValue.number(-10), y: EngineValue.number(0) },
	{ x: EngineValue.number(0), y: EngineValue.number(10) },
])("isLessThan returns true for number comparisons: $x < $y", ({ x, y }) => {
	const result = isLessThan(x, y);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.isBoolean()).toBe(true);
		if (result.value.isBoolean()) {
			expect(result.value.data.value).toBe(true);
		}
	}
});

test.skip.for([
	{ x: EngineValue.number(100), y: EngineValue.number(42) },
	{ x: EngineValue.number(0), y: EngineValue.number(-10) },
	{ x: EngineValue.number(10), y: EngineValue.number(10) },
])("isLessThan returns false for number comparisons: $x >= $y", ({ x, y }) => {
	const result = isLessThan(x, y);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.isBoolean()).toBe(true);
		if (result.value.isBoolean()) {
			expect(result.value.data.value).toBe(false);
		}
	}
});

test.skip("isLessThan returns undefined for NaN < number", () => {
	const x = EngineValue.number(NaN);
	const y = EngineValue.number(42);

	const result = isLessThan(x, y);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.isUndefined()).toBe(true);
	}
});

test.skip("isLessThan returns undefined for number < NaN", () => {
	const x = EngineValue.number(42);
	const y = EngineValue.number(NaN);

	const result = isLessThan(x, y);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.isUndefined()).toBe(true);
	}
});

test.skip("isLessThan returns undefined for NaN < NaN", () => {
	const x = EngineValue.number(NaN);
	const y = EngineValue.number(NaN);

	const result = isLessThan(x, y);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.isUndefined()).toBe(true);
	}
});

test.skip("isLessThan returns true for -Infinity < number", () => {
	const x = EngineValue.number(-Infinity);
	const y = EngineValue.number(42);

	const result = isLessThan(x, y);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.isBoolean()).toBe(true);
		if (result.value.isBoolean()) {
			expect(result.value.data.value).toBe(true);
		}
	}
});

test.skip("isLessThan returns false for number < -Infinity", () => {
	const x = EngineValue.number(42);
	const y = EngineValue.number(-Infinity);

	const result = isLessThan(x, y);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.isBoolean()).toBe(true);
		if (result.value.isBoolean()) {
			expect(result.value.data.value).toBe(false);
		}
	}
});

test.skip("isLessThan returns true for number < +Infinity", () => {
	const x = EngineValue.number(42);
	const y = EngineValue.number(Infinity);

	const result = isLessThan(x, y);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.isBoolean()).toBe(true);
		if (result.value.isBoolean()) {
			expect(result.value.data.value).toBe(true);
		}
	}
});

test.skip("isLessThan returns false for +Infinity < number", () => {
	const x = EngineValue.number(Infinity);
	const y = EngineValue.number(42);

	const result = isLessThan(x, y);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.isBoolean()).toBe(true);
		if (result.value.isBoolean()) {
			expect(result.value.data.value).toBe(false);
		}
	}
});

test.skip("isLessThan returns true for -Infinity < +Infinity", () => {
	const x = EngineValue.number(-Infinity);
	const y = EngineValue.number(Infinity);

	const result = isLessThan(x, y);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.isBoolean()).toBe(true);
		if (result.value.isBoolean()) {
			expect(result.value.data.value).toBe(true);
		}
	}
});

test.skip("isLessThan returns false for +Infinity < -Infinity", () => {
	const x = EngineValue.number(Infinity);
	const y = EngineValue.number(-Infinity);

	const result = isLessThan(x, y);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.isBoolean()).toBe(true);
		if (result.value.isBoolean()) {
			expect(result.value.data.value).toBe(false);
		}
	}
});

test.skip("isLessThan returns true for BigInt < BigInt (numeric)", () => {
	const x = EngineValue.bigint(42n);
	const y = EngineValue.bigint(100n);

	const result = isLessThan(x, y);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.isBoolean()).toBe(true);
		if (result.value.isBoolean()) {
			expect(result.value.data.value).toBe(true);
		}
	}
});

test.skip("isLessThan returns false for BigInt > BigInt (numeric)", () => {
	const x = EngineValue.bigint(100n);
	const y = EngineValue.bigint(42n);

	const result = isLessThan(x, y);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.isBoolean()).toBe(true);
		if (result.value.isBoolean()) {
			expect(result.value.data.value).toBe(false);
		}
	}
});

test.skip("isLessThan with leftFirst=true processes left side first", () => {
	const x = EngineValue.number(42);
	const y = EngineValue.number(100);

	const result = isLessThan(x, y, true);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.isBoolean()).toBe(true);
		if (result.value.isBoolean()) {
			expect(result.value.data.value).toBe(true);
		}
	}
});

test.skip("isLessThan with leftFirst=false processes right side first", () => {
	const x = EngineValue.number(42);
	const y = EngineValue.number(100);

	const result = isLessThan(x, y, false);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.isBoolean()).toBe(true);
		if (result.value.isBoolean()) {
			expect(result.value.data.value).toBe(true);
		}
	}
});

test.for([
	{ x: EngineValue.number(42), y: EngineValue.number(42), expected: true },
	{ x: EngineValue.number(NaN), y: EngineValue.number(42), expected: false },
	{ x: EngineValue.string("hello"), y: EngineValue.string("hello"), expected: true },
	{ x: EngineValue.string("hello"), y: EngineValue.string("world"), expected: false },
	{ x: EngineValue.bigint(42n), y: EngineValue.bigint(42n), expected: true },
	{ x: EngineValue.bigint(42n), y: EngineValue.bigint(100n), expected: false },
	{ x: EngineValue.boolean(true), y: EngineValue.boolean(true), expected: true },
	{ x: EngineValue.boolean(true), y: EngineValue.boolean(false), expected: false },
	{ x: EngineValue.undefined(), y: EngineValue.undefined(), expected: true },
	{ x: EngineValue.null(), y: EngineValue.null(), expected: true },
])("isStrictlyEqual handles same-type comparisons", ({ x, y, expected }) => {
	expect(isStrictlyEqual(x, y).data.value).toBe(expected);
});

test.for([
	{ x: EngineValue.number(42), y: EngineValue.string("42") },
	{ x: EngineValue.bigint(42n), y: EngineValue.number(42) },
	{ x: EngineValue.undefined(), y: EngineValue.null() },
])("isStrictlyEqual returns false for different types", ({ x, y }) => {
	expect(isStrictlyEqual(x, y).data.value).toBe(false);
});

test("isStrictlyEqual returns true for same symbol reference", () => {
	const sym = EngineValue.symbol("test");
	expect(isStrictlyEqual(sym, sym).data.value).toBe(true);
});

test("isStrictlyEqual returns false for different symbol references", () => {
	expect(
		isStrictlyEqual(EngineValue.symbol("test"), EngineValue.symbol("test")).data.value,
	).toBe(false);
});

test("isStrictlyEqual returns true for same object reference", () => {
	const obj = EngineValue.object([]);
	expect(isStrictlyEqual(obj, obj).data.value).toBe(true);
});

test("isStrictlyEqual returns false for different object references", () => {
	expect(isStrictlyEqual(EngineValue.object([]), EngineValue.object([])).data.value).toBe(
		false,
	);
});

test.for([
	{ x: EngineValue.number(42), y: EngineValue.number(42), expected: true },
	{ x: EngineValue.undefined(), y: EngineValue.null(), expected: true },
	{ x: EngineValue.null(), y: EngineValue.undefined(), expected: true },
	{ x: EngineValue.number(42), y: EngineValue.string("42"), expected: true },
	{ x: EngineValue.string("42"), y: EngineValue.number(42), expected: true },
	{ x: EngineValue.bigint(42n), y: EngineValue.string("42"), expected: true },
	{ x: EngineValue.boolean(true), y: EngineValue.number(1), expected: true },
	{ x: EngineValue.boolean(false), y: EngineValue.number(0), expected: true },
	{ x: EngineValue.number(42), y: EngineValue.bigint(42n), expected: true },
])("isLooselyEqual returns true for coercible values: $x == $y", ({ x, y, expected }) => {
	const result = isLooselyEqual(x, y);
	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.data.value).toBe(expected);
	}
});

test.for([
	{ x: EngineValue.number(42), y: EngineValue.string("100") },
	{ x: EngineValue.bigint(42n), y: EngineValue.string("abc") },
	{ x: EngineValue.number(Infinity), y: EngineValue.bigint(42n) },
	{ x: EngineValue.number(NaN), y: EngineValue.bigint(42n) },
])("isLooselyEqual returns false for non-equal coercible values", ({ x, y }) => {
	const result = isLooselyEqual(x, y);
	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.data.value).toBe(false);
	}
});

test.skip.for([
	{ x: EngineValue.string("hello"), y: EngineValue.object([]) },
	{ x: EngineValue.number(42), y: EngineValue.object([]) },
	{ x: EngineValue.bigint(42n), y: EngineValue.object([]) },
	{ x: EngineValue.symbol("test"), y: EngineValue.object([]) },
])(
	"isLooselyEqual returns throw completion when calling toPrimitive on $type == object (not implemented yet)",
	({ x, y }) => {
		const result = isLooselyEqual(x, y);

		expect(result.type).toBe("throw");
	},
);

test.skip.for([
	{ x: EngineValue.object([]), y: EngineValue.string("hello") },
	{ x: EngineValue.object([]), y: EngineValue.number(42) },
	{ x: EngineValue.object([]), y: EngineValue.bigint(42n) },
	{ x: EngineValue.object([]), y: EngineValue.symbol("test") },
])(
	"isLooselyEqual returns throw completion when calling toPrimitive on object == $type (not implemented yet)",
	({ x, y }) => {
		const result = isLooselyEqual(x, y);

		expect(result.type).toBe("throw");
	},
);

test.for([
	{ x: EngineValue.symbol("test"), y: EngineValue.string("test") },
	{ x: EngineValue.symbol("test"), y: EngineValue.number(42) },
])("isLooselyEqual returns false for symbol compared to primitives", ({ x, y }) => {
	const result = isLooselyEqual(x, y);
	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.data.value).toBe(false);
	}
});
