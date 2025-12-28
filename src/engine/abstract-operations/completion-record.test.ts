import { expect, test } from "vitest";
import {
	normalCompletion,
	returnCompletion,
	throwCompletion,
} from "./completion-record.ts";
import type { CompletionRecord } from "./completion-record.ts";

test("normalCompletion creates normal completion record", () => {
	const value = "test value";
	const result = normalCompletion(value);

	expect(result.type).toBe("normal");
	expect(result.value).toBe(value);
	expect(result).not.toHaveProperty("error");
	expect(result).not.toHaveProperty("target");
});

test.for([
	{ value: 42, description: "number" },
	{ value: "string", description: "string" },
	{ value: true, description: "boolean" },
	{ value: null, description: "null" },
	{ value: undefined, description: "undefined" },
	{ value: { object: "test" }, description: "object" },
])("normalCompletion works with $description", ({ value }) => {
	const result = normalCompletion(value);

	expect(result.type).toBe("normal");
	expect(result.value).toBe(value);
});

test("returnCompletion creates return completion record", () => {
	const value = "return value";
	const result = returnCompletion(value);

	expect(result.type).toBe("return");
	expect(result.value).toBe(value);
	expect(result).not.toHaveProperty("error");
	expect(result).not.toHaveProperty("target");
});

test.for([
	{ value: 42, description: "number" },
	{ value: "string", description: "string" },
	{ value: true, description: "boolean" },
	{ value: null, description: "null" },
	{ value: undefined, description: "undefined" },
	{ value: { object: "test" }, description: "object" },
])("returnCompletion works with $description", ({ value }) => {
	const result = returnCompletion(value);

	expect(result.type).toBe("return");
	expect(result.value).toBe(value);
});

test("throwCompletion creates throw completion record", () => {
	const error = new Error("test error");
	const result = throwCompletion(error);

	expect(result.type).toBe("throw");
	expect(result.error).toBe(error);
	expect(result).not.toHaveProperty("value");
	expect(result).not.toHaveProperty("target");
});

test.for([
	{ error: new Error("standard error"), description: "Error" },
	{ error: new TypeError("type error"), description: "TypeError" },
	{ error: new RangeError("range error"), description: "RangeError" },
	{ error: new ReferenceError("reference error"), description: "ReferenceError" },
	{ error: new SyntaxError("syntax error"), description: "SyntaxError" },
])("throwCompletion works with $description", ({ error }) => {
	const result = throwCompletion(error);

	expect(result.type).toBe("throw");
	expect(result.error).toBe(error);
});

test("completion record type discrimination works correctly", () => {
	const normal = normalCompletion("normal");
	const returnRecord = returnCompletion("return");
	const throwRecord = throwCompletion(new Error("throw"));

	// Type guard tests
	if (normal.type === "normal") {
		expect(normal.value).toBe("normal");
	}

	if (returnRecord.type === "return") {
		expect(returnRecord.value).toBe("return");
	}

	if (throwRecord.type === "throw") {
		expect(throwRecord.error).toBeInstanceOf(Error);
	}
});

test("completion records have correct TypeScript types", () => {
	// This test ensures TypeScript type checking works correctly
	const normal: CompletionRecord<string> = normalCompletion("test");
	const returnRecord: CompletionRecord<number> = returnCompletion(42);
	const throwRecord: CompletionRecord<never> = throwCompletion(new Error("test"));

	expect(normal.type).toBe("normal");
	expect(returnRecord.type).toBe("return");
	expect(throwRecord.type).toBe("throw");
});

test("completion record structure matches expected interface", () => {
	const normal = normalCompletion("test");
	const throwRecord = throwCompletion(new Error("test"));

	// Normal completion should have type and value
	expect(Object.keys(normal)).toEqual(["type", "value"]);

	// Throw completion should have type and error
	expect(Object.keys(throwRecord)).toEqual(["type", "error"]);
});
