import { expect, test } from "vitest";
import { evaluateCode, primitiveValue } from "./helpers.ts";

test("evaluates null literal", () => {
	const result = evaluateCode("null");

	expect(result.type).toBe("normal");
	expect(result.value?.isNull()).toBe(true);
});

test("evaluates true literal", () => {
	const result = evaluateCode("true");

	expect(result.type).toBe("normal");
	expect(result.value?.isBoolean()).toBe(true);
	expect(primitiveValue(result)).toBe(true);
});

test("evaluates false literal", () => {
	const result = evaluateCode("false");

	expect(result.type).toBe("normal");
	expect(result.value?.isBoolean()).toBe(true);
	expect(primitiveValue(result)).toBe(false);
});

test("evaluates integer literal", () => {
	const result = evaluateCode("42");

	expect(result.type).toBe("normal");
	expect(result.value?.isNumber()).toBe(true);
	expect(primitiveValue(result)).toBe(42);
});

test("evaluates floating point literal", () => {
	const result = evaluateCode("3.14");

	expect(result.type).toBe("normal");
	expect(result.value?.isNumber()).toBe(true);
	expect(primitiveValue(result)).toBe(3.14);
});

test("evaluates zero literal", () => {
	const result = evaluateCode("0");

	expect(result.type).toBe("normal");
	expect(result.value?.isNumber()).toBe(true);
	expect(primitiveValue(result)).toBe(0);
});

test("evaluates negative number literal", () => {
	const result = evaluateCode("-1");

	expect(result.type).toBe("normal");
	expect(result.value?.isNumber()).toBe(true);
	expect(primitiveValue(result)).toBe(-1);
});

test("evaluates bigint literal", () => {
	const result = evaluateCode("42n");

	expect(result.type).toBe("normal");
	expect(result.value?.isBigInt()).toBe(true);
	expect(primitiveValue(result)).toBe(42n);
});

test("evaluates double-quoted string literal", () => {
	const result = evaluateCode('"hello"');

	expect(result.type).toBe("normal");
	expect(result.value?.isString()).toBe(true);
	expect(primitiveValue(result)).toBe("hello");
});

test("evaluates single-quoted string literal", () => {
	const result = evaluateCode("'world'");

	expect(result.type).toBe("normal");
	expect(result.value?.isString()).toBe(true);
	expect(primitiveValue(result)).toBe("world");
});

test("evaluates empty string literal", () => {
	const result = evaluateCode('""');

	expect(result.type).toBe("normal");
	expect(result.value?.isString()).toBe(true);
	expect(primitiveValue(result)).toBe("");
});
