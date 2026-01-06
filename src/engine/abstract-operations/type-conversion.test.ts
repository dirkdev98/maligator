import { expect, test } from "vitest";
import { EngineValue } from "../types-and-values/data-types.ts";
import {
	toNumber,
	stringToNumber,
	toInt32,
	toUint32,
	toBoolean,
	toNumeric,
	toIntegerOrInfinity,
	toInt16,
	toUint16,
	toInt8,
	toUint8,
	toUint8Clamp,
	toBigint,
	StringToBigInt,
	toBigInt64,
	toString,
	toObject,
	toPropertyKey,
	toLength,
	canonicalNumericIndexString,
	toIndex,
} from "./type-conversion.ts";

test.for([
	{ value: EngineValue.undefined(), expected: false },
	{ value: EngineValue.null(), expected: false },
	{ value: EngineValue.boolean(false), expected: false },
	{ value: EngineValue.number(+0), expected: false },
	{ value: EngineValue.number(-0), expected: false },
	{ value: EngineValue.number(NaN), expected: false },
	{ value: EngineValue.string(""), expected: false },
	{ value: EngineValue.bigint(0n), expected: false },
	{ value: EngineValue.boolean(true), expected: true },
	{ value: EngineValue.number(42), expected: true },
	{ value: EngineValue.string("hello"), expected: true },
	{ value: EngineValue.bigint(42n), expected: true },
	{ value: EngineValue.symbol("test"), expected: true },
	{ value: EngineValue.object([]), expected: true },
])("toBoolean converts values to $expected", ({ value, expected }) => {
	const result = toBoolean(value);
	expect(result.data.value).toBe(expected);
});

test("toNumber returns same value for number input", () => {
	const number = EngineValue.number(42);
	const result = toNumber(number);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value).toBe(number);
	}
});

test.for([
	{
		value: EngineValue.symbol("test"),
		message: "Cannot convert a Symbol value to a number",
	},
	{
		value: EngineValue.bigint(42n),
		message: "Cannot convert a BigInt value to a number",
	},
])("toNumber throws TypeError for $value", ({ value, message }) => {
	const result = toNumber(value);

	expect(result.type).toBe("throw");
	if (result.type === "throw") {
		expect(result.error).toBeInstanceOf(TypeError);
		expect(result.error.message).toBe(message);
	}
});

test.for([
	{ value: EngineValue.undefined(), expected: NaN },
	{ value: EngineValue.null(), expected: 0 },
	{ value: EngineValue.boolean(true), expected: 1 },
	{ value: EngineValue.boolean(false), expected: 0 },
])("toNumber converts $value to number", ({ value, expected }) => {
	const result = toNumber(value);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		if (Number.isNaN(expected)) {
			expect(result.value.data.value).toBeNaN();
		} else {
			expect(result.value.data.value).toBe(expected);
		}
	}
});

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

test("toNumeric returns normal completion for number input", () => {
	const value = EngineValue.number(42);
	const result = toNumeric(value);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.isNumber()).toBe(true);
		expect(result.value.data.value).toBe(42);
	}
});

test("toNumeric returns normal completion for bigint input", () => {
	const value = EngineValue.bigint(42n);
	const result = toNumeric(value);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.isBigInt()).toBe(true);
		expect(result.value.data.value).toBe(42n);
	}
});

test("toNumeric converts numeric strings to numbers", () => {
	const value = EngineValue.string("42");
	const result = toNumeric(value);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.isNumber()).toBe(true);
		expect(result.value.data.value).toBe(42);
	}
});

test("toNumeric converts symbol to throw completion", () => {
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

test.for([{ input: NaN }, { input: +0 }, { input: -0 }])(
	"toIntegerOrInfinity converts $input to 0",
	({ input }) => {
		const value = EngineValue.number(input);
		const result = toIntegerOrInfinity(value);

		expect(result.type).toBe("normal");
		if (result.type === "normal") {
			expect(result.value).toBe(0);
		}
	},
);

test.for([{ input: Infinity }, { input: -Infinity }])(
	"toIntegerOrInfinity returns $input unchanged",
	({ input }) => {
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

test.for([
	{ input: NaN },
	{ input: Infinity },
	{ input: -Infinity },
	{ input: +0 },
	{ input: -0 },
])("toInt32 converts special value $input to 0", ({ input }) => {
	const result = toInt32(EngineValue.number(input));

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

test.for([
	{ input: NaN },
	{ input: Infinity },
	{ input: -Infinity },
	{ input: +0 },
	{ input: -0 },
])("toUint32 converts special value $input to 0", ({ input }) => {
	const result = toUint32(EngineValue.number(input));

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

test.for([
	{ input: NaN },
	{ input: Infinity },
	{ input: -Infinity },
	{ input: +0 },
	{ input: -0 },
])("toInt16 converts special value $input to 0", ({ input }) => {
	const result = toInt16(EngineValue.number(input));

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

test.for([
	{ input: NaN },
	{ input: Infinity },
	{ input: -Infinity },
	{ input: +0 },
	{ input: -0 },
])("toUint16 converts special value $input to 0", ({ input }) => {
	const result = toUint16(EngineValue.number(input));

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

test.for([
	{ input: 0, expected: 0 },
	{ input: 42, expected: 42 },
	{ input: -42, expected: -42 },
	{ input: 127, expected: 127 },
	{ input: -128, expected: -128 },
	{ input: 128, expected: -128 },
	{ input: -129, expected: -129 },
	{ input: 256, expected: 0 },
	{ input: -256, expected: -0 },
	{ input: 257, expected: 1 },
	{ input: -257, expected: -1 },
	{ input: 512, expected: 0 },
])("toInt8 handles 8-bit signed integer overflow for $input", ({ input, expected }) => {
	const value = EngineValue.number(input);
	const result = toInt8(value);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.data.value).toBe(expected);
	}
});

test.for([
	{ input: NaN },
	{ input: Infinity },
	{ input: -Infinity },
	{ input: +0 },
	{ input: -0 },
])("toInt8 converts special value $input to 0", ({ input }) => {
	const result = toInt8(EngineValue.number(input));

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
])("toInt8 floors $input before applying 8-bit conversion", ({ input, expected }) => {
	const value = EngineValue.number(input);
	const result = toInt8(value);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.data.value).toBe(expected);
	}
});

test("toInt8 propagates errors from toNumber", () => {
	const value = EngineValue.symbol("test");
	const result = toInt8(value);

	expect(result.type).toBe("throw");
	if (result.type === "throw") {
		expect(result.error).toBeInstanceOf(TypeError);
	}
});

test.for([
	{ input: 0, expected: 0 },
	{ input: 42, expected: 42 },
	{ input: -42, expected: 214 },
	{ input: 127, expected: 127 },
	{ input: -128, expected: 128 },
	{ input: 255, expected: 255 },
	{ input: 256, expected: 0 },
	{ input: 257, expected: 1 },
	{ input: -1, expected: 255 },
	{ input: -256, expected: 0 },
	{ input: -257, expected: 255 },
	{ input: 512, expected: 0 },
])(
	"toUint8 handles 8-bit unsigned integer overflow for $input",
	({ input, expected }) => {
		const value = EngineValue.number(input);
		const result = toUint8(value);

		expect(result.type).toBe("normal");
		if (result.type === "normal") {
			expect(result.value.data.value).toBe(expected);
		}
	},
);

test.for([
	{ input: NaN },
	{ input: Infinity },
	{ input: -Infinity },
	{ input: +0 },
	{ input: -0 },
])("toUint8 converts special value $input to 0", ({ input }) => {
	const result = toUint8(EngineValue.number(input));

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.data.value).toBe(0);
	}
});

test.for([
	{ input: 3.14, expected: 3 },
	{ input: -3.14, expected: 253 },
	{ input: 42.9, expected: 42 },
	{ input: -42.9, expected: 214 },
])(
	"toUint8 floors $input before applying 8-bit unsigned conversion",
	({ input, expected }) => {
		const value = EngineValue.number(input);
		const result = toUint8(value);

		expect(result.type).toBe("normal");
		if (result.type === "normal") {
			expect(result.value.data.value).toBe(expected);
		}
	},
);

test("toUint8 propagates errors from toNumber", () => {
	const value = EngineValue.symbol("test");
	const result = toUint8(value);

	expect(result.type).toBe("throw");
	if (result.type === "throw") {
		expect(result.error).toBeInstanceOf(TypeError);
	}
});

test.for([
	{ input: 0, expected: 0 },
	{ input: 128, expected: 128 },
	{ input: 255, expected: 255 },
	{ input: 256, expected: 255 },
	{ input: -1, expected: 0 },
	{ input: -100, expected: 0 },
])(
	"toUint8Clamp clamps values to [0, 255] range: $input -> $expected",
	({ input, expected }) => {
		const value = EngineValue.number(input);
		const result = toUint8Clamp(value);

		expect(result.type).toBe("normal");
		if (result.type === "normal") {
			expect(result.value.data.value).toBe(expected);
		}
	},
);

test("toUint8Clamp converts NaN to 0", () => {
	const value = EngineValue.number(NaN);
	const result = toUint8Clamp(value);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.data.value).toBe(0);
	}
});

test.for([
	{ input: 0.4, expected: 0 },
	{ input: 0.5, expected: 0 },
	{ input: 1.5, expected: 1 },
	{ input: 2.5, expected: 2 },
	{ input: 3.5, expected: 3 },
	{ input: 4.5, expected: 4 },
])(
	"toUint8Clamp applies round to even rule for $input (rounds to nearest even)",
	({ input, expected }) => {
		const value = EngineValue.number(input);
		const result = toUint8Clamp(value);

		expect(result.type).toBe("normal");
		if (result.type === "normal") {
			expect(result.value.data.value).toBe(expected);
		}
	},
);

test.for([
	{ input: 0.6, expected: 0 },
	{ input: 1.6, expected: 1 },
	{ input: 2.6, expected: 2 },
])("toUint8Clamp rounds $input towards zero when > .5", ({ input, expected }) => {
	const value = EngineValue.number(input);
	const result = toUint8Clamp(value);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.data.value).toBe(expected);
	}
});

test("toUint8Clamp propagates errors from toNumber", () => {
	const value = EngineValue.symbol("test");
	const result = toUint8Clamp(value);

	expect(result.type).toBe("throw");
	if (result.type === "throw") {
		expect(result.error).toBeInstanceOf(TypeError);
	}
});

test.for([
	{ input: "0", expected: 0n },
	{ input: "42", expected: 42n },
	{ input: "-100", expected: -100n },
	{ input: "9007199254740992", expected: 9007199254740992n },
])(
	"StringToBigInt converts valid decimal string '%s' to bigint",
	({ input, expected }) => {
		const result = StringToBigInt(input);

		expect(result.isBigInt()).toBe(true);
		if (result.isBigInt()) {
			expect(result.data.value).toBe(expected);
		}
	},
);

test.for([
	// { input: "0x2a", expected: 42n },
	{ input: "0XFF", expected: 255n },
	{ input: "0x0", expected: 0n },
	// { input: "-0x2a", expected: -42n },
])("StringToBigInt converts valid hex string '%s' to bigint", ({ input, expected }) => {
	const result = StringToBigInt(input);

	expect(result.isBigInt()).toBe(true);
	if (result.isBigInt()) {
		expect(result.data.value).toBe(expected);
	}
});

test.for([
	{ input: "0o52", expected: 42n },
	{ input: "0O777", expected: 511n },
	{ input: "0o0", expected: 0n },
])("StringToBigInt converts valid octal string '%s' to bigint", ({ input, expected }) => {
	const result = StringToBigInt(input);

	expect(result.isBigInt()).toBe(true);
	if (result.isBigInt()) {
		expect(result.data.value).toBe(expected);
	}
});

test.for([
	{ input: "0b101010", expected: 42n },
	{ input: "0B1111", expected: 15n },
	{ input: "0b0", expected: 0n },
])(
	"StringToBigInt converts valid binary string '%s' to bigint",
	({ input, expected }) => {
		const result = StringToBigInt(input);

		expect(result.isBigInt()).toBe(true);
		if (result.isBigInt()) {
			expect(result.data.value).toBe(expected);
		}
	},
);

test.for(["abc", "42abc", "1.2.3", "1.5", "not a number"])(
	"StringToBigInt returns undefined for invalid string '%s'",
	(input) => {
		expect(StringToBigInt(input).isUndefined()).toBe(true);
	},
);

test("StringToBigInt handles whitespace padding", () => {
	const result = StringToBigInt("  42  ");

	expect(result.isBigInt()).toBe(true);
	if (result.isBigInt()) {
		expect(result.data.value).toBe(42n);
	}
});

test("toBigInt throws TypeError for undefined", () => {
	const value = EngineValue.undefined();
	const result = toBigint(value);

	expect(result.type).toBe("throw");
	if (result.type === "throw") {
		expect(result.error).toBeInstanceOf(TypeError);
		expect(result.error.message).toBe("Cannot convert undefined to a BigInt");
	}
});

test("toBigInt throws TypeError for null", () => {
	const value = EngineValue.null();
	const result = toBigint(value);

	expect(result.type).toBe("throw");
	if (result.type === "throw") {
		expect(result.error).toBeInstanceOf(TypeError);
		expect(result.error.message).toBe("Cannot convert null to a BigInt");
	}
});

test("toBigInt converts boolean true to bigint", () => {
	const value = EngineValue.boolean(true);
	const result = toBigint(value);

	expect(result.type).toBe("normal");
	expect(result.value?.isBigInt()).toBe(true);
	if (result.type === "normal" && result.value.isBigInt()) {
		expect(result.value.data.value).toBe(1n);
	}
});

test("toBigInt converts boolean false to bigint", () => {
	const value = EngineValue.boolean(false);
	const result = toBigint(value);

	expect(result.type).toBe("normal");
	expect(result.value?.isBigInt()).toBe(true);
	if (result.type === "normal" && result.value.isBigInt()) {
		expect(result.value.data.value).toBe(0n);
	}
});

test("toBigInt throws TypeError for number", () => {
	const value = EngineValue.number(42);
	const result = toBigint(value);

	expect(result.type).toBe("throw");
	if (result.type === "throw") {
		expect(result.error).toBeInstanceOf(TypeError);
		expect(result.error.message).toBe("Cannot convert a number to a BigInt");
	}
});

test("toBigInt converts string '42' to bigint", () => {
	const value = EngineValue.string("42");
	const result = toBigint(value);

	expect(result.type).toBe("normal");
	expect(result.value?.isBigInt()).toBe(true);
	if (result.type === "normal" && result.value.isBigInt()) {
		expect(result.value.data.value).toBe(42n);
	}
});

test("toBigInt converts string '0' to bigint", () => {
	const value = EngineValue.string("0");
	const result = toBigint(value);

	expect(result.type).toBe("normal");
	expect(result.value?.isBigInt()).toBe(true);
	if (result.type === "normal" && result.value.isBigInt()) {
		expect(result.value.data.value).toBe(0n);
	}
});

test("toBigInt converts string '-100' to bigint", () => {
	const value = EngineValue.string("-100");
	const result = toBigint(value);

	expect(result.type).toBe("normal");
	expect(result.value?.isBigInt()).toBe(true);
	if (result.type === "normal" && result.value.isBigInt()) {
		expect(result.value.data.value).toBe(-100n);
	}
});

test("toBigInt converts string '9007199254740992' to bigint", () => {
	const value = EngineValue.string("9007199254740992");
	const result = toBigint(value);

	expect(result.type).toBe("normal");
	expect(result.value?.isBigInt()).toBe(true);
	if (result.type === "normal" && result.value.isBigInt()) {
		expect(result.value.data.value).toBe(9007199254740992n);
	}
});

test("toBigInt throws TypeError for symbol", () => {
	const value = EngineValue.symbol("test");
	const result = toBigint(value);

	expect(result.type).toBe("throw");
	if (result.type === "throw") {
		expect(result.error).toBeInstanceOf(TypeError);
		expect(result.error.message).toBe("Cannot convert a Symbol value to a BigInt");
	}
});

test.skip("toBigInt converts object using toPrimitive", () => {
	const value = EngineValue.object([]);
	const result = toBigint(value);

	expect(result.type).toBe("throw");
	if (result.type === "throw") {
		expect(result.error.message).toBe("Not implemented");
	}
});

test.skip("toBigInt64 handles bigint input", () => {
	const value = EngineValue.bigint(0n);
	const result = toBigInt64(value);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.data.value).toBe(0n);
	}
});

test.skip("toBigInt64 handles negative bigint ", () => {
	const value = EngineValue.bigint(-100n);
	const result = toBigInt64(value);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.data.value).toBe(-100n);
	}
});

test.skip("toBigInt64 handles bigint $input", () => {
	const value = EngineValue.bigint(9007199254740991n);
	const result = toBigInt64(value);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.data.value).toBe(9007199254740991n);
	}
});

test.skip("toBigInt64 handles 64-bit wrapping for 9223372036854775807n", () => {
	const value = EngineValue.bigint(9223372036854775807n);
	const result = toBigInt64(value);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.data.value).toBe(9223372036854775807n);
	}
});

test("toBigInt64 handles 64-bit wrapping for -9223372036854775808n", () => {
	const value = EngineValue.bigint(-9223372036854775808n);
	const result = toBigInt64(value);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.data.value).toBe(9223372036854775808n);
	}
});

test("toBigInt64 handles 64-bit wrapping for 9223372036854775808n", () => {
	const value = EngineValue.bigint(9223372036854775808n);
	const result = toBigInt64(value);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.data.value).toBe(9223372036854775808n);
	}
});

test("toBigInt64 handles 64-bit wrapping for -9223372036854775809n", () => {
	const value = EngineValue.bigint(-9223372036854775809n);
	const result = toBigInt64(value);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.data.value).toBe(9223372036854775807n);
	}
});

test("toBigInt64 handles 64-bit wrapping for 18446744073709551616n", () => {
	const value = EngineValue.bigint(18446744073709551616n);
	const result = toBigInt64(value);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.data.value).toBe(0n);
	}
});

test("toBigInt64 propagates errors from toBigint", () => {
	const value = EngineValue.undefined();
	const result = toBigInt64(value);

	expect(result.type).toBe("throw");
	if (result.type === "throw") {
		expect(result.error).toBeInstanceOf(TypeError);
	}
});

test.for([
	{ value: EngineValue.undefined(), expected: "undefined" },
	{ value: EngineValue.null(), expected: "null" },
	{ value: EngineValue.boolean(true), expected: "true" },
	{ value: EngineValue.boolean(false), expected: "false" },
	{ value: EngineValue.number(42), expected: "42" },
	{ value: EngineValue.number(NaN), expected: "NaN" },
	{ value: EngineValue.number(Infinity), expected: "Infinity" },
	{ value: EngineValue.bigint(42n), expected: "42" },
	{ value: EngineValue.bigint(0n), expected: "0" },
])("toString converts $value to '$expected'", ({ value, expected }) => {
	const result = toString(value);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.data.value).toBe(expected);
	}
});

test("toString throws TypeError for symbol", () => {
	const value = EngineValue.symbol("test");
	const result = toString(value);

	expect(result.type).toBe("throw");
	if (result.type === "throw") {
		expect(result.error).toBeInstanceOf(TypeError);
		expect(result.error.message).toBe("Cannot convert a Symbol value to a string");
	}
});

test.skip("toString converts object using toPrimitive", () => {
	const value = EngineValue.object([]);
	const result = toString(value);

	expect(result.type).toBe("throw");
	if (result.type === "throw") {
		expect(result.error.message).toBe("Not implemented");
	}
});

test.skip("toObject throws not implemented error", () => {
	const value = EngineValue.number(42);
	const result = toObject(value);

	expect(result.type).toBe("throw");
	if (result.type === "throw") {
		expect(result.error.message).toBe("Not implemented");
	}
});

test("toPropertyKey returns symbol for symbol input", () => {
	const symbol = EngineValue.symbol("test");
	const result = toPropertyKey(symbol);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value).toBe(symbol);
	}
});

test("toPropertyKey converts number 42 to string", () => {
	const value = EngineValue.number(42);
	const result = toPropertyKey(value);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value).toBe("42");
	}
});

test("toPropertyKey converts number -100 to string", () => {
	const value = EngineValue.number(-100);
	const result = toPropertyKey(value);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value).toBe("-100");
	}
});

test("toPropertyKey converts number 3.14 to string", () => {
	const value = EngineValue.number(3.14);
	const result = toPropertyKey(value);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value).toBe("3.14");
	}
});

test("toPropertyKey converts number 0 to string", () => {
	const value = EngineValue.number(0);
	const result = toPropertyKey(value);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value).toBe("0");
	}
});

test("toPropertyKey converts number Infinity to string", () => {
	const value = EngineValue.number(Infinity);
	const result = toPropertyKey(value);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value).toBe("Infinity");
	}
});

test("toPropertyKey converts number -Infinity to string", () => {
	const value = EngineValue.number(-Infinity);
	const result = toPropertyKey(value);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value).toBe("-Infinity");
	}
});

test("toPropertyKey returns string 42 unchanged", () => {
	const value = EngineValue.string("42");
	const result = toPropertyKey(value);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value).toBe("42");
	}
});

test("toPropertyKey returns string test unchanged", () => {
	const value = EngineValue.string("test");
	const result = toPropertyKey(value);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value).toBe("test");
	}
});

test("toPropertyKey returns string unchanged", () => {
	const value = EngineValue.string("");
	const result = toPropertyKey(value);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value).toBe("");
	}
});

test("toPropertyKey converts boolean true to string", () => {
	const value = EngineValue.boolean(true);
	const result = toPropertyKey(value);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value).toBe("true");
	}
});

test("toPropertyKey converts boolean false to string", () => {
	const value = EngineValue.boolean(false);
	const result = toPropertyKey(value);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value).toBe("false");
	}
});

test.skip("toPropertyKey converts object using toPrimitive", () => {
	const value = EngineValue.object([]);
	const result = toPropertyKey(value);

	expect(result.type).toBe("throw");
	if (result.type === "throw") {
		expect(result.error.message).toBe("Not implemented");
	}
});

test.for([{ input: 0 }, { input: 42 }, { input: 2 ** 53 - 1 }])(
	"toLength converts number $input to length",
	({ input }) => {
		const value = EngineValue.number(input);
		const result = toLength(value);

		expect(result.type).toBe("normal");
		if (result.type === "normal") {
			expect(result.value).toBe(input);
		}
	},
);

test.for([
	{ input: -1 },
	{ input: -100 },
	{ input: -Infinity },
	{ input: NaN },
	{ input: +0 },
	{ input: -0 },
])("toLength converts $input to 0", ({ input }) => {
	const value = EngineValue.number(input);
	const result = toLength(value);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value).toBe(0);
	}
});

test.for([{ input: 2 ** 53 }, { input: 2 ** 53 + 1 }, { input: Infinity }])(
	"toLength clamps $input to 2^53 - 1",
	({ input }) => {
		const value = EngineValue.number(input);
		const result = toLength(value);

		expect(result.type).toBe("normal");
		if (result.type === "normal") {
			expect(result.value).toBe(2 ** 53 - 1);
		}
	},
);

test("toLength propagates errors from toNumber", () => {
	const value = EngineValue.symbol("test");
	const result = toLength(value);

	expect(result.type).toBe("throw");
	if (result.type === "throw") {
		expect(result.error).toBeInstanceOf(TypeError);
	}
});

test("canonicalNumericIndexString returns -0 for '-0'", () => {
	const value = EngineValue.string("-0");
	const result = canonicalNumericIndexString(value);

	expect(result.isNumber()).toBe(true);
	if (result.isNumber()) {
		expect(Object.is(result.data.value, -0)).toBe(true);
	}
});

test.for(["0", "42", "-100", "3.14"])(
	"canonicalNumericIndexString returns number for valid numeric string '%s'",
	(input) => {
		const value = EngineValue.string(input);
		const result = canonicalNumericIndexString(value);

		expect(result.isNumber()).toBe(true);
		if (result.isNumber()) {
			expect(result.data.value).toBe(Number(input));
		}
	},
);

test("canonicalNumericIndexString returns undefined for '1e5' (non-canonical)", () => {
	const value = EngineValue.string("1e5");
	const result = canonicalNumericIndexString(value);

	expect(result.isUndefined()).toBe(true);
});

test.for(["42abc", "3.14.15", "not a number", ""])(
	"canonicalNumericIndexString returns undefined for invalid string '%s'",
	(input) => {
		const value = EngineValue.string(input);
		const result = canonicalNumericIndexString(value);

		expect(result.isUndefined()).toBe(true);
	},
);

test("canonicalNumericIndexString returns Infinity for 'Infinity'", () => {
	const value = EngineValue.string("Infinity");
	const result = canonicalNumericIndexString(value);

	expect(result.isNumber()).toBe(true);
	if (result.isNumber()) {
		expect(result.data.value).toBe(Infinity);
	}
});

test("canonicalNumericIndexString returns NaN for 'NaN'", () => {
	const value = EngineValue.string("NaN");
	const result = canonicalNumericIndexString(value);

	expect(result.isNumber()).toBe(true);
	if (result.isNumber()) {
		expect(result.data.value).toBeNaN();
	}
});

test.for([{ input: 0 }, { input: 42 }, { input: 2 ** 53 - 1 }])(
	"toIndex converts valid number $input to index",
	({ input }) => {
		const value = EngineValue.number(input);
		const result = toIndex(value);

		expect(result.type).toBe("normal");
		if (result.type === "normal") {
			expect(result.value).toBe(input);
		}
	},
);

test("toIndex throws RangeError for negative numbers", () => {
	const value = EngineValue.number(-1);
	const result = toIndex(value);

	expect(result.type).toBe("throw");
	if (result.type === "throw") {
		expect(result.error).toBeInstanceOf(RangeError);
		expect(result.error.message).toBe("Index out of range");
	}
});

test.for([{ input: -100 }, { input: -Infinity }])(
	"toIndex throws RangeError for $input (out of range)",
	({ input }) => {
		const value = EngineValue.number(input);
		const result = toIndex(value);

		expect(result.type).toBe("throw");
		if (result.type === "throw") {
			expect(result.error).toBeInstanceOf(RangeError);
		}
	},
);

test.for([{ input: 2 ** 53 }, { input: 2 ** 53 + 1 }, { input: Infinity }])(
	"toIndex throws RangeError for $input (out of range)",
	({ input }) => {
		const value = EngineValue.number(input);
		const result = toIndex(value);

		expect(result.type).toBe("throw");
		if (result.type === "throw") {
			expect(result.error).toBeInstanceOf(RangeError);
		}
	},
);

test("toIndex propagates errors from toNumber", () => {
	const value = EngineValue.symbol("test");
	const result = toIndex(value);

	expect(result.type).toBe("throw");
	if (result.type === "throw") {
		expect(result.error).toBeInstanceOf(TypeError);
	}
});
