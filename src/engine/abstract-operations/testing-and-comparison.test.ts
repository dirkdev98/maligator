import { expect, test } from "vitest";
import { EngineValue } from "../data-types.ts";
import { normalCompletion } from "./completion-record.ts";
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
} from "./testing-and-comparison.ts";

test("requireObjectCoercible returns throw completion for undefined", () => {
	const argument = EngineValue.undefined();
	const result = requireObjectCoercible(argument);

	expect(result.type).toBe("throw");
	if (result.type === "throw") {
		expect(result.error).toBeInstanceOf(TypeError);
		expect(result.error.message).toBe("Argument can't be converted to an object.");
	}
});

test("requireObjectCoercible returns throw completion for null", () => {
	const argument = EngineValue.null();
	const result = requireObjectCoercible(argument);

	expect(result.type).toBe("throw");
	if (result.type === "throw") {
		expect(result.error).toBeInstanceOf(TypeError);
		expect(result.error.message).toBe("Argument can't be converted to an object.");
	}
});

test("requireObjectCoercible returns normal completion with UNUSED for objects", () => {
	const argument = EngineValue.object([]);
	const result = requireObjectCoercible(argument);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value).toBe(UNUSED);
	}
});

test("requireObjectCoercible returns normal completion with UNUSED for strings", () => {
	const argument = EngineValue.string("hello");
	const result = requireObjectCoercible(argument);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value).toBe(UNUSED);
	}
});

test("requireObjectCoercible returns normal completion with UNUSED for numbers", () => {
	const argument = EngineValue.number(42);
	const result = requireObjectCoercible(argument);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value).toBe(UNUSED);
	}
});

test("requireObjectCoercible returns normal completion with UNUSED for booleans", () => {
	const argument = EngineValue.boolean(true);
	const result = requireObjectCoercible(argument);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value).toBe(UNUSED);
	}
});

test("requireObjectCoercible returns normal completion with UNUSED for symbols", () => {
	const argument = EngineValue.symbol("test");
	const result = requireObjectCoercible(argument);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value).toBe(UNUSED);
	}
});

test("requireObjectCoercible returns normal completion with UNUSED for bigints", () => {
	const argument = EngineValue.bigint(42n);
	const result = requireObjectCoercible(argument);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value).toBe(UNUSED);
	}
});

test("requireObjectCoercible TypeError has correct message", () => {
	const argument = EngineValue.undefined();
	const result = requireObjectCoercible(argument);

	expect(result.type).toBe("throw");
	if (result.type === "throw") {
		expect(result.error.message).toBe("Argument can't be converted to an object.");
	}
});

test("isArray returns false for undefined", () => {
	const value = EngineValue.undefined();
	const result = isArray(value);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.data.value).toBe(false);
	}
});

test("isArray returns false for null", () => {
	const value = EngineValue.null();
	const result = isArray(value);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.data.value).toBe(false);
	}
});

test("isArray returns false for boolean", () => {
	const value = EngineValue.boolean(true);
	const result = isArray(value);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.data.value).toBe(false);
	}
});

test("isArray returns false for string", () => {
	const value = EngineValue.string("hello");
	const result = isArray(value);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.data.value).toBe(false);
	}
});

test("isArray returns false for number", () => {
	const value = EngineValue.number(42);
	const result = isArray(value);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.data.value).toBe(false);
	}
});

test("isArray returns false for symbol", () => {
	const value = EngineValue.symbol("test");
	const result = isArray(value);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.data.value).toBe(false);
	}
});

test("isArray returns false for bigint", () => {
	const value = EngineValue.bigint(42n);
	const result = isArray(value);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.data.value).toBe(false);
	}
});

test("isCallable returns false for undefined", () => {
	const argument = EngineValue.undefined();
	const result = isCallable(argument);

	expect(result.data.value).toBe(false);
});

test("isCallable returns false for null", () => {
	const argument = EngineValue.null();
	const result = isCallable(argument);

	expect(result.data.value).toBe(false);
});

test("isCallable returns false for boolean", () => {
	const argument = EngineValue.boolean(true);
	const result = isCallable(argument);

	expect(result.data.value).toBe(false);
});

test("isCallable returns false for string", () => {
	const argument = EngineValue.string("hello");
	const result = isCallable(argument);

	expect(result.data.value).toBe(false);
});

test("isCallable returns false for number", () => {
	const argument = EngineValue.number(42);
	const result = isCallable(argument);

	expect(result.data.value).toBe(false);
});

test("isCallable returns false for symbol", () => {
	const argument = EngineValue.symbol("test");
	const result = isCallable(argument);

	expect(result.data.value).toBe(false);
});

test("isCallable returns false for bigint", () => {
	const argument = EngineValue.bigint(42n);
	const result = isCallable(argument);

	expect(result.data.value).toBe(false);
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

test("isConstructor returns false for undefined", () => {
	const argument = EngineValue.undefined();
	const result = isConstructor(argument);

	expect(result.data.value).toBe(false);
});

test("isConstructor returns false for null", () => {
	const argument = EngineValue.null();
	const result = isConstructor(argument);

	expect(result.data.value).toBe(false);
});

test("isConstructor returns false for boolean", () => {
	const argument = EngineValue.boolean(true);
	const result = isConstructor(argument);

	expect(result.data.value).toBe(false);
});

test("isConstructor returns false for string", () => {
	const argument = EngineValue.string("hello");
	const result = isConstructor(argument);

	expect(result.data.value).toBe(false);
});

test("isConstructor returns false for number", () => {
	const argument = EngineValue.number(42);
	const result = isConstructor(argument);

	expect(result.data.value).toBe(false);
});

test("isConstructor returns false for symbol", () => {
	const argument = EngineValue.symbol("test");
	const result = isConstructor(argument);

	expect(result.data.value).toBe(false);
});

test("isConstructor returns false for bigint", () => {
	const argument = EngineValue.bigint(42n);
	const result = isConstructor(argument);

	expect(result.data.value).toBe(false);
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

test("isExtensible returns completion from object's IsExtensible internal slot", () => {
	const obj = EngineValue.object([]);
	obj.objectSetInternalSlot("IsExtensible", () => {
		return normalCompletion(EngineValue.boolean(true));
	});

	const result = isExtensible(obj);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.data.value).toBe(true);
	}
});

test("isExtensible returns false for non-extensible object", () => {
	const obj = EngineValue.object([]);
	obj.objectSetInternalSlot("IsExtensible", () => {
		return normalCompletion(EngineValue.boolean(false));
	});

	const result = isExtensible(obj);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.data.value).toBe(false);
	}
});

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

test("sameTypeWrapped returns EngineValue<boolean> for matching types", () => {
	const x = EngineValue.number(42);
	const y = EngineValue.number(-10);

	const result = sameTypeWrapped(x, y);

	expect(result.isBoolean()).toBe(true);
	expect(result.data.value).toBe(true);
});

test("sameTypeWrapped returns EngineValue<boolean> for different types", () => {
	const x = EngineValue.number(42);
	const y = EngineValue.string("42");

	const result = sameTypeWrapped(x, y);

	expect(result.isBoolean()).toBe(true);
	expect(result.data.value).toBe(false);
});

test.for([{ x: 42 }, { x: -100 }, { x: 3.14 }, { x: 0 }, { x: -0 }])(
	"sameValue returns true for equal number $x",
	({ x }) => {
		const result = sameValue(EngineValue.number(x), EngineValue.number(x));
		expect(result).toBe(true);
	},
);

test("sameValue returns true for NaN (Object.is semantics)", () => {
	const x = EngineValue.number(NaN);
	const y = EngineValue.number(NaN);

	const result = sameValue(x, y);

	expect(result).toBe(true);
});

test("sameValue returns false for NaN compared to non-NaN", () => {
	const x = EngineValue.number(NaN);
	const y = EngineValue.number(42);

	const result = sameValue(x, y);

	expect(result).toBe(false);
});

test("sameValue distinguishes positive and negative zero: +0 !== -0", () => {
	const x = EngineValue.number(0);
	const y = EngineValue.number(-0);

	const result = sameValue(x, y);

	expect(result).toBe(false);
});

test("sameValue distinguishes negative and positive zero: -0 !== +0", () => {
	const x = EngineValue.number(-0);
	const y = EngineValue.number(0);

	const result = sameValue(x, y);

	expect(result).toBe(false);
});

test.for([
	{ x: EngineValue.number(42), y: EngineValue.number(100) },
	{ x: EngineValue.number(-10), y: EngineValue.number(10) },
	{ x: EngineValue.number(3.14), y: EngineValue.number(3.15) },
])("sameValue returns false for unequal numbers: $x !== $y", ({ x, y }) => {
	const result = sameValue(x, y);

	expect(result).toBe(false);
});

test.for([
	{ x: EngineValue.undefined(), y: EngineValue.undefined() },
	{ x: EngineValue.null(), y: EngineValue.null() },
])("sameValue returns true for identical $type values", ({ x, y }) => {
	const result = sameValue(x, y);

	expect(result).toBe(true);
});

test("sameValue returns true for identical bigint values", () => {
	const x = EngineValue.bigint(42n);
	const y = EngineValue.bigint(42n);

	const result = sameValue(x, y);

	expect(result).toBe(true);
});

test("sameValue returns false for unequal bigint values", () => {
	const x = EngineValue.bigint(42n);
	const y = EngineValue.bigint(100n);

	const result = sameValue(x, y);

	expect(result).toBe(false);
});

test("sameValue returns true for identical string values", () => {
	const x = EngineValue.string("hello");
	const y = EngineValue.string("hello");

	const result = sameValue(x, y);

	expect(result).toBe(true);
});

test.for([
	{ x: EngineValue.string("hello"), y: EngineValue.string("world") },
	{ x: EngineValue.string(""), y: EngineValue.string("x") },
	{ x: EngineValue.string("a"), y: EngineValue.string("A") },
])("sameValue returns false for unequal strings: $x !== $y", ({ x, y }) => {
	const result = sameValue(x, y);

	expect(result).toBe(false);
});

test.for([
	{ x: EngineValue.boolean(true), y: EngineValue.boolean(true) },
	{ x: EngineValue.boolean(false), y: EngineValue.boolean(false) },
])("sameValue returns true for identical boolean $x values", ({ x, y }) => {
	const result = sameValue(x, y);

	expect(result).toBe(true);
});

test("sameValue returns false for different boolean values", () => {
	const x = EngineValue.boolean(true);
	const y = EngineValue.boolean(false);

	const result = sameValue(x, y);

	expect(result).toBe(false);
});

test("sameValue returns true for identical object references", () => {
	const obj = EngineValue.object([]);
	const x = obj;
	const y = obj;

	const result = sameValue(x, y);

	expect(result).toBe(true);
});

test("sameValue returns false for different object references", () => {
	const x = EngineValue.object([]);
	const y = EngineValue.object([]);

	const result = sameValue(x, y);

	expect(result).toBe(false);
});

test.for([
	{ x: EngineValue.number(42), y: EngineValue.string("42") },
	{ x: EngineValue.bigint(42n), y: EngineValue.number(42) },
	{ x: EngineValue.boolean(true), y: EngineValue.number(1) },
])("sameValue returns false for different types: $type !== $type", ({ x, y }) => {
	const result = sameValue(x, y);

	expect(result).toBe(false);
});

test("sameValueWrapped returns EngineValue<boolean>", () => {
	const x = EngineValue.number(42);
	const y = EngineValue.number(42);

	const result = sameValueWrapped(x, y);

	expect(result.isBoolean()).toBe(true);
	expect(result.data.value).toBe(true);
});

test.for([
	{ x: EngineValue.number(42), y: EngineValue.number(42) },
	{ x: EngineValue.number(-100), y: EngineValue.number(-100) },
	{ x: EngineValue.number(3.14), y: EngineValue.number(3.14) },
	{ x: EngineValue.number(0), y: EngineValue.number(0) },
	{ x: EngineValue.number(-0), y: EngineValue.number(-0) },
])("sameValueZero returns true for equal number $x", ({ x, y }) => {
	const result = sameValueZero(x, y);

	expect(result).toBe(true);
});

test("sameValueZero returns true for NaN (SameValueZero semantics)", () => {
	const x = EngineValue.number(NaN);
	const y = EngineValue.number(NaN);

	const result = sameValueZero(x, y);

	expect(result).toBe(true);
});

test("sameValueZero returns false for NaN compared to non-NaN", () => {
	const x = EngineValue.number(NaN);
	const y = EngineValue.number(42);

	const result = sameValueZero(x, y);

	expect(result).toBe(false);
});

test("sameValueZero treats positive and negative zero as equal: +0 === -0", () => {
	const x = EngineValue.number(0);
	const y = EngineValue.number(-0);

	const result = sameValueZero(x, y);

	expect(result).toBe(true);
});

test("sameValueZero treats negative and positive zero as equal: -0 === +0", () => {
	const x = EngineValue.number(-0);
	const y = EngineValue.number(0);

	const result = sameValueZero(x, y);

	expect(result).toBe(true);
});

test.for([
	{ x: EngineValue.number(42), y: EngineValue.number(100) },
	{ x: EngineValue.number(-10), y: EngineValue.number(10) },
	{ x: EngineValue.number(3.14), y: EngineValue.number(3.15) },
])("sameValueZero returns false for unequal numbers: $x !== $y", ({ x, y }) => {
	const result = sameValueZero(x, y);

	expect(result).toBe(false);
});

test.for([
	{ x: EngineValue.undefined(), y: EngineValue.undefined() },
	{ x: EngineValue.null(), y: EngineValue.null() },
	{ x: EngineValue.bigint(42n), y: EngineValue.bigint(42n) },
	{ x: EngineValue.string("hello"), y: EngineValue.string("hello") },
	{ x: EngineValue.boolean(true), y: EngineValue.boolean(true) },
])("sameValueZero returns true for identical non-number $type values", ({ x, y }) => {
	const result = sameValueZero(x, y);

	expect(result).toBe(true);
});

test.for([
	{ x: EngineValue.number(42), y: EngineValue.string("42") },
	{ x: EngineValue.bigint(42n), y: EngineValue.number(42) },
])("sameValueZero returns false for different types: $type !== $type", ({ x, y }) => {
	const result = sameValueZero(x, y);

	expect(result).toBe(false);
});

test("sameValueZeroWrapped returns EngineValue<boolean>", () => {
	const x = EngineValue.number(42);
	const y = EngineValue.number(42);

	const result = sameValueZeroWrapped(x, y);

	expect(result.isBoolean()).toBe(true);
	expect(result.data.value).toBe(true);
});

test("sameValueNonNumber returns true for undefined comparisons", () => {
	const x = EngineValue.undefined();
	const y = EngineValue.undefined();

	const result = sameValueNonNumber(x, y);

	expect(result).toBe(true);
});

test("sameValueNonNumber returns true for null comparisons", () => {
	const x = EngineValue.null();
	const y = EngineValue.null();

	const result = sameValueNonNumber(x, y);

	expect(result).toBe(true);
});

test.for([
	{ x: EngineValue.bigint(42n), y: EngineValue.bigint(42n) },
	{ x: EngineValue.bigint(-100n), y: EngineValue.bigint(-100n) },
	{ x: EngineValue.bigint(0n), y: EngineValue.bigint(0n) },
])("sameValueNonNumber returns true for equal bigint $x values", ({ x, y }) => {
	const result = sameValueNonNumber(x, y);

	expect(result).toBe(true);
});

test.for([
	{ x: EngineValue.bigint(42n), y: EngineValue.bigint(100n) },
	{ x: EngineValue.bigint(42n), y: EngineValue.bigint(-42n) },
])("sameValueNonNumber returns false for unequal bigint $x !== $y", ({ x, y }) => {
	const result = sameValueNonNumber(x, y);

	expect(result).toBe(false);
});

test("sameValueNonNumber returns true for equal string values", () => {
	const x = EngineValue.string("hello");
	const y = EngineValue.string("hello");

	const result = sameValueNonNumber(x, y);

	expect(result).toBe(true);
});

test("sameValueNonNumber returns true for empty string comparison", () => {
	const x = EngineValue.string("");
	const y = EngineValue.string("");

	const result = sameValueNonNumber(x, y);

	expect(result).toBe(true);
});

test.for([
	{ x: EngineValue.string("hello"), y: EngineValue.string("world") },
	{ x: EngineValue.string(""), y: EngineValue.string("x") },
	{ x: EngineValue.string("a"), y: EngineValue.string("A") },
])("sameValueNonNumber returns false for unequal strings: $x !== $y", ({ x, y }) => {
	const result = sameValueNonNumber(x, y);

	expect(result).toBe(false);
});

test.for([
	{ x: EngineValue.boolean(true), y: EngineValue.boolean(true) },
	{ x: EngineValue.boolean(false), y: EngineValue.boolean(false) },
])("sameValueNonNumber returns true for identical boolean $x values", ({ x, y }) => {
	const result = sameValueNonNumber(x, y);

	expect(result).toBe(true);
});

test("sameValueNonNumber returns false for different boolean values", () => {
	const x = EngineValue.boolean(true);
	const y = EngineValue.boolean(false);

	const result = sameValueNonNumber(x, y);

	expect(result).toBe(false);
});

test("sameValueNonNumber returns true for identical object references", () => {
	const obj = EngineValue.object([]);
	const x = obj;
	const y = obj;

	const result = sameValueNonNumber(x, y);

	expect(result).toBe(true);
});

test("sameValueNonNumber returns false for different object references", () => {
	const x = EngineValue.object([]);
	const y = EngineValue.object([]);

	const result = sameValueNonNumber(x, y);

	expect(result).toBe(false);
});

test.for([
	{ x: EngineValue.string("hello"), y: EngineValue.number(42) },
	{ x: EngineValue.bigint(42n), y: EngineValue.number(42) },
	{ x: EngineValue.boolean(true), y: EngineValue.string("true") },
])(
	"sameValueNonNumber returns false for different types: $type !== $type",
	({ x, y }) => {
		const result = sameValueNonNumber(x, y);

		expect(result).toBe(false);
	},
);

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
