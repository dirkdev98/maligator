import { expect, test } from "vitest";
import { evaluateCode, primitiveValue } from "./helpers.ts";

// typeof operator

test("typeof undefined returns 'undefined'", () => {
	const result = evaluateCode("typeof undefined");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe("undefined");
});

test("typeof null returns 'object'", () => {
	const result = evaluateCode("typeof null");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe("object");
});

test("typeof boolean returns 'boolean'", () => {
	const result = evaluateCode("typeof true");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe("boolean");
});

test("typeof number returns 'number'", () => {
	const result = evaluateCode("typeof 42");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe("number");
});

test("typeof string returns 'string'", () => {
	const result = evaluateCode('typeof "hello"');

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe("string");
});

test("typeof bigint returns 'bigint'", () => {
	const result = evaluateCode("typeof 42n");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe("bigint");
});

test("typeof unresolvable reference returns 'undefined'", () => {
	const result = evaluateCode("typeof nonExistentVariable");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe("undefined");
});

// void operator

test("void returns undefined for any expression", () => {
	const result = evaluateCode("void 42");

	expect(result.type).toBe("normal");
	expect(result.value?.isUndefined()).toBe(true);
});

test("void returns undefined for string", () => {
	const result = evaluateCode('void "hello"');

	expect(result.type).toBe("normal");
	expect(result.value?.isUndefined()).toBe(true);
});

test("void 0 returns undefined", () => {
	const result = evaluateCode("void 0");

	expect(result.type).toBe("normal");
	expect(result.value?.isUndefined()).toBe(true);
});

// Logical NOT operator

test("logical NOT of true returns false", () => {
	const result = evaluateCode("!true");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(false);
});

test("logical NOT of false returns true", () => {
	const result = evaluateCode("!false");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(true);
});

test("logical NOT of truthy value returns false", () => {
	const result = evaluateCode("!1");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(false);
});

test("logical NOT of falsy value returns true", () => {
	const result = evaluateCode("!0");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(true);
});

test("double logical NOT converts to boolean true", () => {
	const result = evaluateCode("!!1");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(true);
});

test("double logical NOT converts to boolean false", () => {
	const result = evaluateCode("!!0");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(false);
});

// Unary plus operator

test("unary plus converts string to number", () => {
	const result = evaluateCode('+"42"');

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(42);
});

test("unary plus on number returns same number", () => {
	const result = evaluateCode("+42");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(42);
});

test("unary plus on boolean true returns 1", () => {
	const result = evaluateCode("+true");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(1);
});

test("unary plus on null returns 0", () => {
	const result = evaluateCode("+null");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(0);
});

// Unary minus operator

test("unary minus negates positive number", () => {
	const result = evaluateCode("-42");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(-42);
});

test("unary minus negates negative number", () => {
	const result = evaluateCode("- -42");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(42);
});

test("unary minus on zero returns negative zero", () => {
	const result = evaluateCode("-0");

	expect(result.type).toBe("normal");
	expect(Object.is(primitiveValue(result), -0)).toBe(true);
});

test("unary minus negates bigint", () => {
	const result = evaluateCode("-42n");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(-42n);
});

// Bitwise NOT operator

test("bitwise NOT inverts bits", () => {
	const result = evaluateCode("~0");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(-1);
});

test("bitwise NOT of -1 returns 0", () => {
	const result = evaluateCode("~-1");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(0);
});

test("bitwise NOT of 5 returns -6", () => {
	const result = evaluateCode("~5");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(-6);
});

test("bitwise NOT of bigint", () => {
	const result = evaluateCode("~5n");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(-6n);
});

// Nested expressions

test("nested unary operators: double negation", () => {
	const result = evaluateCode("- -5");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(5);
});

test("nested unary operators: typeof with void", () => {
	const result = evaluateCode("typeof void 0");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe("undefined");
});

test("chained logical NOT operators", () => {
	const result = evaluateCode("!!!true");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(false);
});

test("unary minus with binary expression", () => {
	const result = evaluateCode("-(2 + 3)");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(-5);
});

test("bitwise NOT with arithmetic", () => {
	const result = evaluateCode("~(1 + 2)");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(-4);
});
