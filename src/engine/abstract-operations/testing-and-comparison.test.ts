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
