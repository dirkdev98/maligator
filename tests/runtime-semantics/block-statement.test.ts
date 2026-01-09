import { expect, test } from "vitest";
import { evaluateCode, primitiveValue } from "./helpers.ts";

// Basic block evaluation

test("empty block returns undefined", () => {
	const result = evaluateCode("{}");

	expect(result.type).toBe("normal");
	expect(result.value).toBeUndefined();
});

test("block with single expression statement", () => {
	const result = evaluateCode("{ 42 }");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(42);
});

test("block with multiple statements returns last value", () => {
	const result = evaluateCode("{ 1; 2; 3 }");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(3);
});

// Block scoping

test("block creates new scope for let", () => {
	const result = evaluateCode("let x = 1; { let x = 2; x }");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(2);
});

test("outer variable accessible inside block", () => {
	const result = evaluateCode("let x = 10; { x + 5 }");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(15);
});

test("variable declared in block not accessible outside", () => {
	// Inner y is scoped to block, outer x still accessible after block
	const result = evaluateCode("let x = 1; { let y = 2; y } x");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(1);
});

// Nested blocks

test("nested blocks evaluate correctly", () => {
	const result = evaluateCode("{ { 42 } }");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(42);
});

test("deeply nested blocks with expressions", () => {
	const result = evaluateCode("{ { { 1 + 2 + 3 } } }");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(6);
});

test("nested blocks with variable shadowing", () => {
	const result = evaluateCode("let x = 1; { let x = 2; { let x = 3; x } }");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(3);
});

// Complex scenarios

test("block with variable and expression", () => {
	const result = evaluateCode("{ let a = 5; let b = 3; a * b }");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(15);
});

test("multiple blocks in sequence", () => {
	const result = evaluateCode("let r = 0; { r = 1 } { r = r + 1 } r");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(2);
});

test("block with complex nested expressions", () => {
	const result = evaluateCode("{ let x = 2; let y = 3; (x + y) * (x - y) + x * y }");

	expect(result.type).toBe("normal");
	// (2+3) * (2-3) + 2*3 = 5 * -1 + 6 = -5 + 6 = 1
	expect(primitiveValue(result)).toBe(1);
});

test("block with logical operators", () => {
	const result = evaluateCode("{ let a = true; let b = false; a && !b }");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(true);
});

test("block with comparison chain", () => {
	const result = evaluateCode("{ let x = 5; x > 3 && x < 10 }");

	expect(result.type).toBe("normal");
	expect(primitiveValue(result)).toBe(true);
});
