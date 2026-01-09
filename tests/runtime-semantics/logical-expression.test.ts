import { expect, test } from "vitest";
import { evaluateCode, primitiveValue } from "./helpers.ts";

// Logical AND (&&)

test("logical AND returns right operand when left is truthy", () => {
	const result = evaluateCode("true && 42");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(42);
});

test("logical AND returns left operand when left is falsy", () => {
	const result = evaluateCode("false && 42");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(false);
});

test("logical AND short-circuits on falsy left operand", () => {
	const result = evaluateCode("0 && 42");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(0);
});

test("logical AND evaluates right when left is truthy number", () => {
	const result = evaluateCode("1 && 42");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(42);
});

test("logical AND with null returns null", () => {
	const result = evaluateCode("null && 42");

	expect(result.type).toBe("normal");
	expect(result.value?.isNull()).toBe(true);
});

test("logical AND with empty string returns empty string", () => {
	const result = evaluateCode('"" && 42');

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe("");
});

// Logical OR (||)

test("logical OR returns left operand when left is truthy", () => {
	const result = evaluateCode("true || 42");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(true);
});

test("logical OR returns right operand when left is falsy", () => {
	const result = evaluateCode("false || 42");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(42);
});

test("logical OR short-circuits on truthy left operand", () => {
	const result = evaluateCode("1 || 42");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(1);
});

test("logical OR evaluates right when left is falsy number", () => {
	const result = evaluateCode("0 || 42");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(42);
});

test("logical OR with null evaluates right", () => {
	const result = evaluateCode('null || "default"');

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe("default");
});

test("logical OR with non-empty string returns string", () => {
	const result = evaluateCode('"hello" || "default"');

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe("hello");
});

// Nullish coalescing (??)

test("nullish coalescing returns left when not nullish", () => {
	const result = evaluateCode("42 ?? 0");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(42);
});

test("nullish coalescing returns right when left is null", () => {
	const result = evaluateCode("null ?? 42");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(42);
});

test("nullish coalescing returns right when left is undefined", () => {
	const result = evaluateCode("undefined ?? 42");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(42);
});

test("nullish coalescing returns 0 (not nullish)", () => {
	const result = evaluateCode("0 ?? 42");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(0);
});

test("nullish coalescing returns empty string (not nullish)", () => {
	const result = evaluateCode('"" ?? "default"');

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe("");
});

test("nullish coalescing returns false (not nullish)", () => {
	const result = evaluateCode("false ?? true");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(false);
});

// Complex/nested expressions

test("chained logical AND evaluates left to right", () => {
	const result = evaluateCode("true && 1 && 2 && 3");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(3);
});

test("chained logical AND stops at first falsy", () => {
	const result = evaluateCode("true && 0 && 2 && 3");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(0);
});

test("chained logical OR stops at first truthy", () => {
	const result = evaluateCode("null || 0 || 1 || 2");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(1);
});

test("mixed logical operators with correct precedence", () => {
	const result = evaluateCode("false || true && 42");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(42);
});

test("nested logical expressions with parentheses", () => {
	const result = evaluateCode("(false || true) && (0 || 42)");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(42);
});

test("nullish coalescing with logical OR fallback", () => {
	const result = evaluateCode("(null ?? 0) || 42");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(42);
});

test("complex expression with comparison and logical", () => {
	const result = evaluateCode("(1 < 2) && (3 > 2) && 42");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(42);
});

test("logical AND with comparison returns boolean", () => {
	const result = evaluateCode("true && (5 === 5)");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(true);
});
