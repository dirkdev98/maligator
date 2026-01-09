import { expect, test } from "vitest";
import { evaluateCode, primitiveValue } from "./helpers.ts";

// Let declarations

test("let declaration with initializer", () => {
	const result = evaluateCode("let x = 42; x");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(42);
});

test("let declaration with string initializer", () => {
	const result = evaluateCode('let name = "hello"; name');

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe("hello");
});

test("let declaration without initializer defaults to undefined", () => {
	const result = evaluateCode("let x; x");

	expect(result.type).toBe("normal");
	expect(result.value?.isUndefined()).toBe(true);
});

test("let declaration with boolean initializer", () => {
	const result = evaluateCode("let flag = true; flag");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(true);
});

test("let declaration with null initializer", () => {
	const result = evaluateCode("let empty = null; empty");

	expect(result.type).toBe("normal");
	expect(result.value?.isNull()).toBe(true);
});

// Const declarations

test("const declaration with number", () => {
	const result = evaluateCode("const PI = 3.14; PI");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(3.14);
});

test("const declaration with string", () => {
	const result = evaluateCode('const greeting = "hi"; greeting');

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe("hi");
});

test("const declaration with bigint", () => {
	const result = evaluateCode("const big = 100n; big");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(100n);
});

// Initialization with expressions

test("let declaration initialized with expression", () => {
	const result = evaluateCode("let sum = 1 + 2; sum");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(3);
});

test("const declaration initialized with complex expression", () => {
	const result = evaluateCode("const result = (2 + 3) * 4; result");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(20);
});

test("let declaration initialized with logical expression", () => {
	const result = evaluateCode("let val = true && 42; val");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(42);
});

test("let declaration initialized with comparison", () => {
	const result = evaluateCode("let isLess = 1 < 2; isLess");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(true);
});

// Multiple statements with variables

test("multiple let declarations and usage", () => {
	const result = evaluateCode("let a = 1; let b = 2; a + b");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(3);
});

test("variable used in subsequent expression", () => {
	const result = evaluateCode("let x = 10; x * 2");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(20);
});

test("variable used in another variable initialization", () => {
	const result = evaluateCode("let a = 5; let b = a + 3; b");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(8);
});

test("chained variable dependencies", () => {
	const result = evaluateCode("let a = 1; let b = a + 1; let c = b + 1; c");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(3);
});

// Complex nested scenarios

test("variable with nested binary operations", () => {
	const result = evaluateCode("let x = 2 ** 3 + 4 * 2; x");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(16);
});

test("variable with unary operator", () => {
	const result = evaluateCode("let neg = -42; neg");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(-42);
});

test("variable with typeof expression", () => {
	const result = evaluateCode('let t = typeof "hello"; t');

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe("string");
});

test("multiple variables in complex expression", () => {
	const result = evaluateCode("let a = 2; let b = 3; let c = 4; a * b + c");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(10);
});

test("variable reassignment in expression context", () => {
	const result = evaluateCode("let x = 1; x = x + 1; x");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(2);
});
