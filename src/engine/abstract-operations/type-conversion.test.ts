import { expect, test } from "vitest";
import { EngineValue } from "../data-types.ts";
import {
	toNumber,
	stringToNumber,
	toInt32,
	toUint32,
	toPrimitive,
	ordinaryToPrimitive,
	toBoolean,
	toNumeric,
	toIntegerOrInfinity,
	toInt16,
	toUint16,
} from "./type-conversion.ts";

test.skip("toPrimitive throws not implemented error", () => {
	const value = EngineValue.object([]);
	const result = toPrimitive(value);

	expect(result.type).toBe("throw");
	if (result.type === "throw") {
		expect(result.error.message).toBe("Not implemented");
	}
});

test.skip("ordinaryToPrimitive throws not implemented error", () => {
	const value = EngineValue.object([]);
	const result = ordinaryToPrimitive(value, "number");

	expect(result.type).toBe("throw");
	if (result.type === "throw") {
		expect(result.error.message).toBe("Not implemented");
	}
});

test.for([
	EngineValue.undefined(),
	EngineValue.null(),
	EngineValue.boolean(false),
	EngineValue.number(+0),
	EngineValue.number(-0),
	EngineValue.number(NaN),
	EngineValue.string(""),
	EngineValue.bigint(0n),
])("toBoolean converts falsy values to false", (value) => {
	const result = toBoolean(value);

	expect(result.isBoolean()).toBe(true);
	expect(result.data.value).toBe(false);
});

test.for([
	EngineValue.boolean(true),
	EngineValue.number(42),
	EngineValue.number(-42),
	EngineValue.string("hello"),
	EngineValue.bigint(42n),
	EngineValue.symbol("test"),
	EngineValue.object([]),
])("toBoolean converts truthy values to true", (value) => {
	const result = toBoolean(value);

	expect(result.isBoolean()).toBe(true);
	expect(result.data.value).toBe(true);
});

test("toNumber returns normal completion for number input", () => {
	const number = EngineValue.number(42);
	const result = toNumber(number);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value).toBe(number);
	}
});

test("toNumber throws for symbol input", () => {
	const symbol = EngineValue.symbol("test");
	const result = toNumber(symbol);

	expect(result.type).toBe("throw");
	if (result.type === "throw") {
		expect(result.error).toBeInstanceOf(TypeError);
		expect(result.error.message).toBe("Cannot convert a Symbol value to a number");
	}
});

test("toNumber throws for bigint input", () => {
	const bigint = EngineValue.bigint(42n);
	const result = toNumber(bigint);

	expect(result.type).toBe("throw");
	if (result.type === "throw") {
		expect(result.error).toBeInstanceOf(TypeError);
		expect(result.error.message).toBe("Cannot convert a BigInt value to a number");
	}
});

test("toNumber converts undefined to NaN", () => {
	const undefinedValue = EngineValue.undefined();
	const result = toNumber(undefinedValue);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.data.value).toBeNaN();
	}
});

test("toNumber converts null to 0", () => {
	const nullValue = EngineValue.null();
	const result = toNumber(nullValue);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.data.value).toBe(0);
	}
});

test.for([true, false])(
	"toNumber converts boolean %s to the correct number",
	(boolValue) => {
		const boolean = EngineValue.boolean(boolValue);
		const result = toNumber(boolean);

		expect(result.type).toBe("normal");
		if (result.type === "normal") {
			expect(result.value.data.value).toBe(boolValue ? 1 : 0);
		}
	},
);

test.for(["42", "0", "-1.5", "3.14159", "1e5", "-1e-3", "   10   "])(
	"toNumber converts string '%s' to the correct number",
	(stringValue) => {
		const string = EngineValue.string(stringValue);
		const result = toNumber(string);

		expect(result.type).toBe("normal");
		if (result.type === "normal") {
			expect(result.value.data.value).toBe(Number(stringValue));
		}
	},
);

test.for(["not a number", "42abc", "1.2.3", "undefined", "null"])(
	"toNumber converts invalid string '%s' to NaN",
	(stringValue) => {
		const string = EngineValue.string(stringValue);
		const result = toNumber(string);

		expect(result.type).toBe("normal");
		if (result.type === "normal") {
			expect(result.value.data.value).toBeNaN();
		}
	},
);

test("toNumber converts an empty string to 0 (per JavaScript spec)", () => {
	const string = EngineValue.string("");
	const result = toNumber(string);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.data.value).toBe(0);
	}
});

test("stringToNumber converts valid numeric strings", () => {
	expect(stringToNumber("42").data.value).toBe(42);
	expect(stringToNumber("-1.5").data.value).toBe(-1.5);
	expect(stringToNumber("1e5").data.value).toBe(100000);
});

test("stringToNumber converts an empty string to 0 (per JavaScript spec)", () => {
	expect(stringToNumber("").data.value).toBe(0);
});

test("stringToNumber converts invalid strings to NaN", () => {
	expect(stringToNumber("abc").data.value).toBeNaN();
	expect(stringToNumber("42abc").data.value).toBeNaN();
});

test.skip("toNumeric returns normal completion for number input", () => {
	const value = EngineValue.number(42);
	const result = toNumeric(value);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.isNumber()).toBe(true);
		expect(result.value.data.value).toBe(42);
	}
});

test.skip("toNumeric returns normal completion for bigint input", () => {
	const value = EngineValue.bigint(42n);
	const result = toNumeric(value);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.isBigInt()).toBe(true);
		expect(result.value.data.value).toBe(42n);
	}
});

test.skip("toNumeric converts numeric strings to numbers", () => {
	const value = EngineValue.string("42");
	const result = toNumeric(value);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.isNumber()).toBe(true);
		expect(result.value.data.value).toBe(42);
	}
});

test.skip("toNumeric converts symbol to throw completion", () => {
	const value = EngineValue.symbol("test");
	const result = toNumeric(value);

	expect(result.type).toBe("throw");
	if (result.type === "throw") {
		expect(result.error).toBeInstanceOf(TypeError);
	}
});

test.skip("toNumeric converts object using toPrimitive", () => {
	const value = EngineValue.object([]);
	const result = toNumeric(value);

	expect(result.type).toBe("throw");
	if (result.type === "throw") {
		expect(result.error.message).toBe("Not implemented");
	}
});

test.for([
	{ input: 0, expected: 0 },
	{ input: 42, expected: 42 },
	{ input: -42, expected: -42 },
	{ input: 3.14, expected: 3 },
	{ input: -3.14, expected: -3 },
	{ input: 42.9, expected: 42 },
	{ input: -42.9, expected: -42 },
])("toIntegerOrInfinity truncates $input to integer", ({ input, expected }) => {
	const value = EngineValue.number(input);
	const result = toIntegerOrInfinity(value);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value).toBe(expected);
	}
});

test.for([NaN, +0, -0])("toIntegerOrInfinity converts $input to 0", (input) => {
	const value = EngineValue.number(input);
	const result = toIntegerOrInfinity(value);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value).toBe(0);
	}
});

test.for([Infinity, -Infinity])(
	"toIntegerOrInfinity returns $input unchanged",
	(input) => {
		const value = EngineValue.number(input);
		const result = toIntegerOrInfinity(value);

		expect(result.type).toBe("normal");
		if (result.type === "normal") {
			expect(result.value).toBe(input);
		}
	},
);

test("toIntegerOrInfinity propagates errors from toNumber", () => {
	const value = EngineValue.symbol("test");
	const result = toIntegerOrInfinity(value);

	expect(result.type).toBe("throw");
	if (result.type === "throw") {
		expect(result.error).toBeInstanceOf(TypeError);
	}
});

test.for([
	{ input: 0, expected: 0 },
	{ input: 42, expected: 42 },
	{ input: -42, expected: -42 },
	{ input: 2147483647, expected: 2147483647 }, // 2^31 - 1
	{ input: -2147483648, expected: -2147483648 }, // -2^31
	{ input: 4294967296, expected: 0 }, // 2^32 wraps to 0
	{ input: 4294967297, expected: 1 }, // 2^32 + 1 wraps to 1
])(
	"toInt32 handles 32-bit integer overflow for $input by wrapping around modulo 2^32",
	({ input, expected }) => {
		const number = EngineValue.number(input);
		const result = toInt32(number);

		expect(result.type).toBe("normal");
		if (result.type === "normal") {
			expect(result.value.data.value).toBe(expected);
		}
	},
);

test("toInt32 converts NaN to 0", () => {
	const nan = EngineValue.number(NaN);
	const result = toInt32(nan);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.data.value).toBe(0);
	}
});

test("toInt32 converts Infinity to 0", () => {
	const infinity = EngineValue.number(Infinity);
	const result = toInt32(infinity);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.data.value).toBe(0);
	}
});

test("toInt32 converts -Infinity to 0", () => {
	const negativeInfinity = EngineValue.number(-Infinity);
	const result = toInt32(negativeInfinity);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.data.value).toBe(0);
	}
});

test("toInt32 converts positive zero to 0", () => {
	const positiveZero = EngineValue.number(+0);
	const result = toInt32(positiveZero);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.data.value).toBe(0);
	}
});

test("toInt32 converts negative zero to 0", () => {
	const negativeZero = EngineValue.number(-0);
	const result = toInt32(negativeZero);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.data.value).toBe(0);
	}
});

test("toInt32 propagates errors from toNumber", () => {
	const symbol = EngineValue.symbol("test");
	const result = toInt32(symbol);

	expect(result.type).toBe("throw");
	if (result.type === "throw") {
		expect(result.error).toBeInstanceOf(TypeError);
	}
});

test.for([
	{ input: 3.14, expected: 3 },
	{ input: -3.14, expected: -3 },
	{ input: 42.9, expected: 42 },
	{ input: -42.9, expected: -42 },
])("toInt32 floors $input before applying 32-bit conversion", ({ input, expected }) => {
	const number = EngineValue.number(input);
	const result = toInt32(number);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.data.value).toBe(expected);
	}
});

test.for([
	{ input: 0, expected: 0 },
	{ input: 42, expected: 42 },
	{ input: -42, expected: 4294967254 }, // -42 mod 2^32
	{ input: 2147483647, expected: 2147483647 }, // 2^31 - 1
	{ input: -2147483648, expected: 2147483648 }, // -2^32 + 2^31 = 2^31
	{ input: 4294967295, expected: 4294967295 }, // 2^32 - 1
	{ input: 4294967296, expected: 0 }, // 2^32 wraps to 0
	{ input: 4294967297, expected: 1 }, // 2^32 + 1 wraps to 1
	{ input: 8589934591, expected: 4294967295 }, // 2^33 - 1 wraps to 2^32 - 1
	{ input: 8589934592, expected: 0 }, // 2^33 wraps to 0
])(
	"toUint32 handles 32-bit unsigned integer overflow for $input by wrapping around modulo 2^32",
	({ input, expected }) => {
		const number = EngineValue.number(input);
		const result = toUint32(number);

		expect(result.type).toBe("normal");
		if (result.type === "normal") {
			expect(result.value.data.value).toBe(expected);
		}
	},
);

test("toUint32 converts NaN to 0", () => {
	const nan = EngineValue.number(NaN);
	const result = toUint32(nan);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.data.value).toBe(0);
	}
});

test("toUint32 converts Infinity to 0", () => {
	const infinity = EngineValue.number(Infinity);
	const result = toUint32(infinity);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.data.value).toBe(0);
	}
});

test("toUint32 converts -Infinity to 0", () => {
	const negativeInfinity = EngineValue.number(-Infinity);
	const result = toUint32(negativeInfinity);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.data.value).toBe(0);
	}
});

test("toUint32 converts positive zero to 0", () => {
	const positiveZero = EngineValue.number(+0);
	const result = toUint32(positiveZero);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.data.value).toBe(0);
	}
});

test("toUint32 converts negative zero to 0", () => {
	const negativeZero = EngineValue.number(-0);
	const result = toUint32(negativeZero);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.data.value).toBe(0);
	}
});

test("toUint32 propagates errors from toNumber", () => {
	const symbol = EngineValue.symbol("test");
	const result = toUint32(symbol);

	expect(result.type).toBe("throw");
	if (result.type === "throw") {
		expect(result.error).toBeInstanceOf(TypeError);
	}
});

test.for([
	{ input: 3.14, expected: 3 },
	{ input: -3.14, expected: 4294967293 }, // -3 mod 2^32 = 2^32 - 3
	{ input: 42.9, expected: 42 },
	{ input: -42.9, expected: 4294967254 }, // -42 mod 2^32 = 2^32 - 42
])(
	"toUint32 floors $input before applying 32-bit unsigned conversion",
	({ input, expected }) => {
		const number = EngineValue.number(input);
		const result = toUint32(number);

		expect(result.type).toBe("normal");
		if (result.type === "normal") {
			expect(result.value.data.value).toBe(expected);
		}
	},
);

test.for([
	{ input: 0, expected: 0 },
	{ input: 42, expected: 42 },
	{ input: -42, expected: -42 },
	{ input: 32767, expected: 32767 },
	{ input: -32768, expected: -32768 },
	{ input: 32768, expected: -32768 },
	{ input: -32769, expected: -32769 },
	{ input: 65536, expected: 0 },
	{ input: -65536, expected: -0 },
	{ input: 65537, expected: 1 },
	{ input: -65537, expected: -1 },
	{ input: 131072, expected: 0 },
])("toInt16 handles 16-bit signed integer overflow for $input", ({ input, expected }) => {
	const value = EngineValue.number(input);
	const result = toInt16(value);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.data.value).toBe(expected);
	}
});

test("toInt16 converts NaN to 0", () => {
	const value = EngineValue.number(NaN);
	const result = toInt16(value);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.data.value).toBe(0);
	}
});

test.for([Infinity, -Infinity, +0, -0])("toInt16 converts $input to 0", (input) => {
	const value = EngineValue.number(input);
	const result = toInt16(value);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.data.value).toBe(0);
	}
});

test.for([
	{ input: 3.14, expected: 3 },
	{ input: -3.14, expected: -3 },
	{ input: 42.9, expected: 42 },
	{ input: -42.9, expected: -42 },
])("toInt16 floors $input before applying 16-bit conversion", ({ input, expected }) => {
	const value = EngineValue.number(input);
	const result = toInt16(value);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.data.value).toBe(expected);
	}
});

test("toInt16 propagates errors from toNumber", () => {
	const value = EngineValue.symbol("test");
	const result = toInt16(value);

	expect(result.type).toBe("throw");
	if (result.type === "throw") {
		expect(result.error).toBeInstanceOf(TypeError);
	}
});

test.for([
	{ input: 0, expected: 0 },
	{ input: 42, expected: 42 },
	{ input: -42, expected: 65494 },
	{ input: 32767, expected: 32767 },
	{ input: -32768, expected: 32768 },
	{ input: 65535, expected: 65535 },
	{ input: 65536, expected: 0 },
	{ input: 65537, expected: 1 },
	{ input: -1, expected: 65535 },
	{ input: -65536, expected: 0 },
	{ input: -65537, expected: 65535 },
	{ input: 131072, expected: 0 },
])(
	"toUint16 handles 16-bit unsigned integer overflow for $input",
	({ input, expected }) => {
		const value = EngineValue.number(input);
		const result = toUint16(value);

		expect(result.type).toBe("normal");
		if (result.type === "normal") {
			expect(result.value.data.value).toBe(expected);
		}
	},
);

test("toUint16 converts NaN to 0", () => {
	const value = EngineValue.number(NaN);
	const result = toUint16(value);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.data.value).toBe(0);
	}
});

test.for([Infinity, -Infinity, +0, -0])("toUint16 converts $input to 0", (input) => {
	const value = EngineValue.number(input);
	const result = toUint16(value);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.data.value).toBe(0);
	}
});

test.for([
	{ input: 3.14, expected: 3 },
	{ input: -3.14, expected: 65533 },
	{ input: 42.9, expected: 42 },
	{ input: -42.9, expected: 65494 },
])(
	"toUint16 floors $input before applying 16-bit unsigned conversion",
	({ input, expected }) => {
		const value = EngineValue.number(input);
		const result = toUint16(value);

		expect(result.type).toBe("normal");
		if (result.type === "normal") {
			expect(result.value.data.value).toBe(expected);
		}
	},
);

test("toUint16 propagates errors from toNumber", () => {
	const value = EngineValue.symbol("test");
	const result = toUint16(value);

	expect(result.type).toBe("throw");
	if (result.type === "throw") {
		expect(result.error).toBeInstanceOf(TypeError);
	}
});
