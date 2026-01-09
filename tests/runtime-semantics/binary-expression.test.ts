import { expect, test } from "vitest";
import { evaluateCode, primitiveValue } from "./helpers.ts";

// Arithmetic operators

test("evaluates addition of two numbers", () => {
	const result = evaluateCode("1 + 2");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(3);
});

test("evaluates subtraction of two numbers", () => {
	const result = evaluateCode("5 - 3");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(2);
});

test("evaluates multiplication of two numbers", () => {
	const result = evaluateCode("4 * 3");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(12);
});

test("evaluates division of two numbers", () => {
	const result = evaluateCode("10 / 2");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(5);
});

test("evaluates modulo of two numbers", () => {
	const result = evaluateCode("10 % 3");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(1);
});

test("evaluates exponentiation of two numbers", () => {
	const result = evaluateCode("2 ** 3");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(8);
});

// String concatenation

test("evaluates string concatenation", () => {
	const result = evaluateCode('"hello" + " " + "world"');

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe("hello world");
});

test("evaluates string and number concatenation", () => {
	const result = evaluateCode('"value: " + 42');

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe("value: 42");
});

// Bitwise operators

test("evaluates bitwise AND", () => {
	const result = evaluateCode("7 & 3");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(3);
});

test("evaluates bitwise OR", () => {
	const result = evaluateCode("5 | 3");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(7);
});

test("evaluates bitwise XOR", () => {
	const result = evaluateCode("5 ^ 3");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(6);
});

test("evaluates left shift", () => {
	const result = evaluateCode("1 << 3");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(8);
});

test("evaluates signed right shift", () => {
	const result = evaluateCode("8 >> 2");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(2);
});

test("evaluates unsigned right shift", () => {
	const result = evaluateCode("-1 >>> 0");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(4294967295);
});

// Equality operators

test("evaluates strict equality for equal values", () => {
	const result = evaluateCode("42 === 42");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(true);
});

test("evaluates strict equality for different values", () => {
	const result = evaluateCode("42 === 43");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(false);
});

test("evaluates strict inequality", () => {
	const result = evaluateCode("42 !== 43");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(true);
});

test("evaluates loose equality with type coercion", () => {
	const result = evaluateCode('"42" == 42');

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(true);
});

test("evaluates loose inequality", () => {
	const result = evaluateCode('"42" != 43');

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(true);
});

// Relational operators

test("evaluates less than for true case", () => {
	const result = evaluateCode("1 < 2");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(true);
});

test("evaluates less than for false case", () => {
	const result = evaluateCode("2 < 1");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(false);
});

test("evaluates greater than", () => {
	const result = evaluateCode("3 > 2");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(true);
});

test("evaluates less than or equal", () => {
	const result = evaluateCode("2 <= 2");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(true);
});

test("evaluates greater than or equal", () => {
	const result = evaluateCode("3 >= 3");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(true);
});

// BigInt operations

test("evaluates bigint addition", () => {
	const result = evaluateCode("1n + 2n");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(3n);
});

test("evaluates bigint multiplication", () => {
	const result = evaluateCode("3n * 4n");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(12n);
});

// Nested/complex expressions

test("evaluates nested arithmetic expression", () => {
	const result = evaluateCode("(1 + 2) * (3 + 4)");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(21);
});

test("evaluates chained comparisons via logical operators", () => {
	const result = evaluateCode("1 < 2 && 2 < 3");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(true);
});

test("evaluates complex arithmetic with multiple operators", () => {
	const result = evaluateCode("2 + 3 * 4 - 6 / 2");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(11);
});

test("evaluates deeply nested expression", () => {
	const result = evaluateCode("((1 + 2) * 3 + 4) * 2");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(26);
});

// Error cases

test("throws TypeError for mixed number and bigint operations", () => {
	const result = evaluateCode("1n + 2");

	expect(result.type).toBe("throw");
	expect(result.error).toBeInstanceOf(TypeError);
});
