import { expect, test } from "vitest";
import { EngineValue } from "../data-types.ts";
import { requireObjectCoercible, UNUSED } from "./testing-and-comparison.ts";

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
