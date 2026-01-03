import { expect, test } from "vitest";
import { EngineValue } from "./data-types.ts";

test("bigintUnaryMinus negates positive bigints", () => {
	const number = EngineValue.bigint(42n);
	const result = number.bigintUnaryMinus();
	expect(result.data.value).toBe(-42n);
});

test("bigintUnaryMinus returns 0n for 0n input", () => {
	const zero = EngineValue.bigint(0n);
	const result = zero.bigintUnaryMinus();
	expect(result.data.value).toBe(0n);
});

test.for([
	{ input: 42n, expected: -43n },
	{ input: 0n, expected: -1n },
	{ input: -1n, expected: 0n },
	{ input: -42n, expected: 41n },
])("bigintBitwiseNOT returns bitwise complement: $input", ({ input, expected }) => {
	const number = EngineValue.bigint(input);
	const result = number.bigintBitwiseNOT();
	expect(result.data.value).toBe(expected);
});

test.for([
	{ base: 2n, exponent: 3n, expected: 8n },
	{ base: 3n, exponent: 4n, expected: 81n },
	{ base: 5n, exponent: 0n, expected: 1n },
	{ base: 10n, exponent: 1n, expected: 10n },
])(
	"bigintExponentiate handles basic exponentiation: $base ** $exponent = $expected",
	({ base, exponent, expected }) => {
		const baseValue = EngineValue.bigint(base);
		const exponentValue = EngineValue.bigint(exponent);
		const result = baseValue.bigintExponentiate(exponentValue);
		expect(result.type).toBe("normal");
		if (result.type === "normal") {
			expect(result.value.data.value).toBe(expected);
		}
	},
);

test("bigintExponentiate handles zero base with zero exponent: 0n ** 0n = 1n", () => {
	const base = EngineValue.bigint(0n);
	const exponent = EngineValue.bigint(0n);
	const result = base.bigintExponentiate(exponent);
	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.data.value).toBe(1n);
	}
});

test("bigintExponentiate handles zero base with positive exponent", () => {
	const base = EngineValue.bigint(0n);
	const exponent = EngineValue.bigint(5n);
	const result = base.bigintExponentiate(exponent);
	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.data.value).toBe(0n);
	}
});

test.for([
	{ x: 2n, y: 3n, expected: 6n },
	{ x: -2n, y: 3n, expected: -6n },
	{ x: 2n, y: -3n, expected: -6n },
	{ x: -2n, y: -3n, expected: 6n },
	{ x: 0n, y: 5n, expected: 0n },
	{ x: 5n, y: 0n, expected: 0n },
])("bigintMultiply handles sign rules: $x * $y = $expected", ({ x, y, expected }) => {
	const xValue = EngineValue.bigint(x);
	const yValue = EngineValue.bigint(y);
	const result = xValue.bigintMultiply(yValue);
	expect(result.data.value).toBe(expected);
});

test("bigintMultiply handles zero operands", () => {
	const zero = EngineValue.bigint(0n);
	const number = EngineValue.bigint(42n);

	expect(zero.bigintMultiply(number).data.value).toBe(0n);
	expect(number.bigintMultiply(zero).data.value).toBe(0n);
	expect(zero.bigintMultiply(zero).data.value).toBe(0n);
});

test("bigintMultiply handles large numbers", () => {
	const x = EngineValue.bigint(123456789n);
	const y = EngineValue.bigint(987654321n);
	const result = x.bigintMultiply(y);
	expect(result.data.value).toBe(121932631112635269n);
});

test.for([
	{ x: 6n, y: 3n, expected: 2n },
	{ x: -6n, y: 3n, expected: -2n },
	{ x: 6n, y: -3n, expected: -2n },
	{ x: -6n, y: -3n, expected: 2n },
	{ x: 0n, y: 5n, expected: 0n },
	{ x: 7n, y: 2n, expected: 3n },
	{ x: -7n, y: 2n, expected: -3n },
])("bigintDivide handles basic division: $x / $y = $expected", ({ x, y, expected }) => {
	const xValue = EngineValue.bigint(x);
	const yValue = EngineValue.bigint(y);
	const result = xValue.bigintDivide(yValue);
	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.data.value).toBe(expected);
	}
});

test("bigintDivide throws RangeError for division by zero", () => {
	const x = EngineValue.bigint(42n);
	const y = EngineValue.bigint(0n);
	const result = x.bigintDivide(y);
	expect(result.type).toBe("throw");
	if (result.type === "throw") {
		expect(result.error).toBeInstanceOf(RangeError);
		expect(result.error.message).toBe("Cannot divide by zero");
	}
});

test("bigintDivide handles dividing zero by non-zero", () => {
	const zero = EngineValue.bigint(0n);
	const y = EngineValue.bigint(5n);
	const result = zero.bigintDivide(y);
	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.data.value).toBe(0n);
	}
});

test.for([
	{ n: 10n, d: 3n, expected: 1n },
	{ n: 10n, d: -3n, expected: 1n },
	{ n: -10n, d: 3n, expected: -1n },
	{ n: -10n, d: -3n, expected: -1n },
	{ n: 7n, d: 2n, expected: 1n },
	{ n: 0n, d: 5n, expected: 0n },
	{ n: 5n, d: 1n, expected: 0n },
])("bigintRemainder handles basic cases: $n % $d = $expected", ({ n, d, expected }) => {
	const nValue = EngineValue.bigint(n);
	const dValue = EngineValue.bigint(d);
	const result = nValue.bigintRemainder(dValue);
	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.data.value).toBe(expected);
	}
});

test("bigintRemainder throws RangeError for division by zero", () => {
	const n = EngineValue.bigint(42n);
	const d = EngineValue.bigint(0n);
	const result = n.bigintRemainder(d);
	expect(result.type).toBe("throw");
	if (result.type === "throw") {
		expect(result.error).toBeInstanceOf(RangeError);
		expect(result.error.message).toBe("Cannot divide by zero");
	}
});

test("bigintRemainder returns 0n when dividend is 0n", () => {
	const zero = EngineValue.bigint(0n);
	const d = EngineValue.bigint(5n);
	const result = zero.bigintRemainder(d);
	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.data.value).toBe(0n);
	}
});

test.for([
	{ n: 6n, d: 4n, expected: 2n },
	{ n: -6n, d: 4n, expected: -2n },
	{ n: 6n, d: -4n, expected: 2n },
	{ n: -6n, d: -4n, expected: -2n },
])(
	"bigintRemainder follows truncating division remainder rule for $n % $d = $expected",
	({ n, d, expected }) => {
		const nValue = EngineValue.bigint(n);
		const dValue = EngineValue.bigint(d);
		const result = nValue.bigintRemainder(dValue);
		expect(result.type).toBe("normal");
		if (result.type === "normal") {
			expect(result.value.data.value).toBe(expected);
		}
	},
);

test.for([
	{ x: 2n, y: 3n, expected: 5n },
	{ x: -2n, y: 3n, expected: 1n },
	{ x: 2n, y: -3n, expected: -1n },
	{ x: -2n, y: -3n, expected: -5n },
	{ x: 0n, y: 5n, expected: 5n },
	{ x: 5n, y: 0n, expected: 5n },
])("bigintAdd handles basic cases: $x + $y = $expected", ({ x, y, expected }) => {
	const xValue = EngineValue.bigint(x);
	const yValue = EngineValue.bigint(y);
	const result = xValue.bigintAdd(yValue);
	expect(result.data.value).toBe(expected);
});

test.for([
	{ x: 5n, y: 3n, expected: 2n },
	{ x: -5n, y: 3n, expected: -8n },
	{ x: 5n, y: -3n, expected: 8n },
	{ x: -5n, y: -3n, expected: -2n },
	{ x: 0n, y: 5n, expected: -5n },
	{ x: 5n, y: 0n, expected: 5n },
])("bigintSubtract handles basic cases: $x - $y = $expected", ({ x, y, expected }) => {
	const xValue = EngineValue.bigint(x);
	const yValue = EngineValue.bigint(y);
	const result = xValue.bigintSubtract(yValue);
	expect(result.data.value).toBe(expected);
});

test.for([
	{ x: 1n, y: 0n, expected: 1n },
	{ x: 1n, y: 1n, expected: 2n },
	{ x: 1n, y: 2n, expected: 4n },
	{ x: 1n, y: 3n, expected: 8n },
	{ x: 2n, y: 1n, expected: 4n },
	{ x: 2n, y: 2n, expected: 8n },
	{ x: 4n, y: 1n, expected: 8n },
	{ x: 8n, y: 2n, expected: 32n },
	{ x: 16n, y: 3n, expected: 128n },
])(
	"bigintLeftShift handles basic bit shifting: $x << $y = $expected",
	({ x, y, expected }) => {
		const xValue = EngineValue.bigint(x);
		const yValue = EngineValue.bigint(y);
		const result = xValue.bigintLeftShift(yValue);
		expect(result.data.value).toBe(expected);
	},
);

test.for([
	{ x: -1n, y: 0n, expected: -1n },
	{ x: -1n, y: 1n, expected: -2n },
	{ x: -1n, y: 2n, expected: -4n },
	{ x: -1n, y: 3n, expected: -8n },
	{ x: -2n, y: 1n, expected: -4n },
	{ x: -4n, y: 1n, expected: -8n },
	{ x: -8n, y: 2n, expected: -32n },
])(
	"bigintLeftShift handles negative numbers: $x << $y = $expected",
	({ x, y, expected }) => {
		const xValue = EngineValue.bigint(x);
		const yValue = EngineValue.bigint(y);
		const result = xValue.bigintLeftShift(yValue);
		expect(result.data.value).toBe(expected);
	},
);

test.for([
	{ x: 8n, y: -1n, expected: 4n },
	{ x: 8n, y: -2n, expected: 2n },
	{ x: 8n, y: -3n, expected: 1n },
	{ x: 16n, y: -1n, expected: 8n },
	{ x: 32n, y: -3n, expected: 4n },
	{ x: 64n, y: -4n, expected: 4n },
])(
	"bigintLeftShift handles negative shift counts (right shift): $x << $y = $expected",
	({ x, y, expected }) => {
		const xValue = EngineValue.bigint(x);
		const yValue = EngineValue.bigint(y);
		const result = xValue.bigintLeftShift(yValue);
		expect(result.data.value).toBe(expected);
	},
);

test("bigintLeftShift handles large shift counts", () => {
	const x = EngineValue.bigint(1n);
	const y = EngineValue.bigint(100n);
	const result = x.bigintLeftShift(y);
	expect(result.data.value).toBe(1267650600228229401496703205376n);
});

test("bigintLeftShift handles zero operands", () => {
	const zero = EngineValue.bigint(0n);
	const number = EngineValue.bigint(42n);

	expect(zero.bigintLeftShift(number).data.value).toBe(0n);
	expect(number.bigintLeftShift(zero).data.value).toBe(number.data.value);
});

test.for([
	{ x: 8n, y: 1n, expected: 4n },
	{ x: 8n, y: 2n, expected: 2n },
	{ x: 8n, y: 3n, expected: 1n },
	{ x: 16n, y: 1n, expected: 8n },
	{ x: 16n, y: 2n, expected: 4n },
	{ x: 32n, y: 3n, expected: 4n },
	{ x: 64n, y: 4n, expected: 4n },
])(
	"bigintSignedRightShift handles basic shifting: $x >> $y = $expected",
	({ x, y, expected }) => {
		const xValue = EngineValue.bigint(x);
		const yValue = EngineValue.bigint(y);
		const result = xValue.bigintSignedRightShift(yValue);
		expect(result.data.value).toBe(expected);
	},
);

test.for([
	{ x: -8n, y: 1n, expected: -4n },
	{ x: -8n, y: 2n, expected: -2n },
	{ x: -8n, y: 3n, expected: -1n },
	{ x: -16n, y: 1n, expected: -8n },
	{ x: -16n, y: 2n, expected: -4n },
	{ x: -32n, y: 3n, expected: -4n },
])(
	"bigintSignedRightShift handles negative numbers: $x >> $y = $expected",
	({ x, y, expected }) => {
		const xValue = EngineValue.bigint(x);
		const yValue = EngineValue.bigint(y);
		const result = xValue.bigintSignedRightShift(yValue);
		expect(result.data.value).toBe(expected);
	},
);

test.for([
	{ x: 8n, y: -1n, expected: 16n },
	{ x: 8n, y: -2n, expected: 32n },
	{ x: 8n, y: -3n, expected: 64n },
	{ x: 16n, y: -1n, expected: 32n },
	{ x: 32n, y: -3n, expected: 256n },
])(
	"bigintSignedRightShift handles negative shift counts (left shift): $x >> $y = $expected",
	({ x, y, expected }) => {
		const xValue = EngineValue.bigint(x);
		const yValue = EngineValue.bigint(y);
		const result = xValue.bigintSignedRightShift(yValue);
		expect(result.data.value).toBe(expected);
	},
);

test("bigintSignedRightShift handles zero operands", () => {
	const zero = EngineValue.bigint(0n);
	const number = EngineValue.bigint(42n);

	expect(zero.bigintSignedRightShift(number).data.value).toBe(0n);
	expect(number.bigintSignedRightShift(zero).data.value).toBe(number.data.value);
});

test("bigintUnsignedRightShift throws TypeError", () => {
	const x = EngineValue.bigint(42n);
	const y = EngineValue.bigint(2n);
	const result = x.bigintUnsignedRightShift(y);
	expect(result.type).toBe("throw");
	if (result.type === "throw") {
		expect(result.error).toBeInstanceOf(TypeError);
		expect(result.error.message).toBe("Cannot shift unsigned bigints");
	}
});

test.for([
	{ x: 3n, y: 5n, expected: true },
	{ x: 5n, y: 3n, expected: false },
	{ x: 3n, y: 3n, expected: false },
	{ x: -5n, y: 3n, expected: true },
	{ x: -3n, y: -5n, expected: false },
	{ x: -5n, y: -3n, expected: true },
	{ x: 0n, y: 0n, expected: false },
	{ x: 0n, y: 5n, expected: true },
	{ x: 5n, y: 0n, expected: false },
])("bigintLessThan handles comparisons: $x < $y = $expected", ({ x, y, expected }) => {
	const xValue = EngineValue.bigint(x);
	const yValue = EngineValue.bigint(y);
	const result = xValue.bigintLessThan(yValue);
	expect(result.data.value).toBe(expected);
});

test.for([
	{ x: 5n, y: 5n, expected: true },
	{ x: 5n, y: 3n, expected: false },
	{ x: 3n, y: 5n, expected: false },
	{ x: 0n, y: 0n, expected: true },
	{ x: -5n, y: -5n, expected: true },
	{ x: 42n, y: 42n, expected: true },
])(
	"bigintEqual returns true for equal bigints: $x === $y = $expected",
	({ x, y, expected }) => {
		const xValue = EngineValue.bigint(x);
		const yValue = EngineValue.bigint(y);
		const result = xValue.bigintEqual(yValue);
		expect(result.data.value).toBe(expected);
	},
);

test.for([
	{ x: 1n, y: 1n, expected: 1n },
	{ x: 1n, y: 0n, expected: 0n },
	{ x: 0n, y: 1n, expected: 0n },
	{ x: 0n, y: 0n, expected: 0n },
	{ x: 5n, y: 3n, expected: 1n },
	{ x: 7n, y: 3n, expected: 3n },
	{ x: 6n, y: 3n, expected: 2n },
	{ x: 12n, y: 10n, expected: 8n },
	{ x: 15n, y: 10n, expected: 10n },
])("bigintBitwiseAND handles bitwise AND: $x & $y = $expected", ({ x, y, expected }) => {
	const xValue = EngineValue.bigint(x);
	const yValue = EngineValue.bigint(y);
	const result = xValue.bigintBitwiseAND(yValue);
	expect(result.data.value).toBe(expected);
});

test.for([
	{ x: 1n, y: 1n, expected: 1n },
	{ x: 1n, y: 0n, expected: 1n },
	{ x: 0n, y: 1n, expected: 1n },
	{ x: 0n, y: 0n, expected: 0n },
	{ x: 5n, y: 3n, expected: 7n },
	{ x: 7n, y: 3n, expected: 7n },
	{ x: 6n, y: 3n, expected: 7n },
	{ x: 12n, y: 10n, expected: 14n },
	{ x: 15n, y: 10n, expected: 15n },
])("bigintBitwiseOR handles bitwise OR: $x | $y = $expected", ({ x, y, expected }) => {
	const xValue = EngineValue.bigint(x);
	const yValue = EngineValue.bigint(y);
	const result = xValue.bigintBitwiseOR(yValue);
	expect(result.data.value).toBe(expected);
});

test.for([
	{ x: 1n, y: 1n, expected: 0n },
	{ x: 1n, y: 0n, expected: 1n },
	{ x: 0n, y: 1n, expected: 1n },
	{ x: 0n, y: 0n, expected: 0n },
	{ x: 5n, y: 3n, expected: 6n },
	{ x: 7n, y: 3n, expected: 4n },
	{ x: 6n, y: 3n, expected: 5n },
	{ x: 12n, y: 10n, expected: 6n },
	{ x: 15n, y: 10n, expected: 5n },
])("bigintBitwiseXOR handles bitwise XOR: $x ^ $y = $expected", ({ x, y, expected }) => {
	const xValue = EngineValue.bigint(x);
	const yValue = EngineValue.bigint(y);
	const result = xValue.bigintBitwiseXOR(yValue);
	expect(result.data.value).toBe(expected);
});

test.for([
	{ x: -1n, y: -1n, expected: -1n },
	{ x: -1n, y: 0n, expected: 0n },
	{ x: 0n, y: -1n, expected: 0n },
	{ x: -5n, y: 3n, expected: 3n },
	{ x: -6n, y: 3n, expected: 2n },
	{ x: -7n, y: -3n, expected: -7n },
])(
	"bigintBitwiseAND handles negative numbers: $x & $y = $expected",
	({ x, y, expected }) => {
		const xValue = EngineValue.bigint(x);
		const yValue = EngineValue.bigint(y);
		const result = xValue.bigintBitwiseAND(yValue);
		expect(result.data.value).toBe(expected);
	},
);

test.for([
	{ x: -1n, y: -1n, expected: -1n },
	{ x: -1n, y: 0n, expected: -1n },
	{ x: 0n, y: -1n, expected: -1n },
	{ x: -5n, y: 3n, expected: -5n },
	{ x: -6n, y: 3n, expected: -5n },
	{ x: -7n, y: -3n, expected: -3n },
])(
	"bigintBitwiseOR handles negative numbers: $x | $y = $expected",
	({ x, y, expected }) => {
		const xValue = EngineValue.bigint(x);
		const yValue = EngineValue.bigint(y);
		const result = xValue.bigintBitwiseOR(yValue);
		expect(result.data.value).toBe(expected);
	},
);

test.for([
	{ x: -1n, y: -1n, expected: 0n },
	{ x: -1n, y: 0n, expected: -1n },
	{ x: 0n, y: -1n, expected: -1n },
	{ x: -5n, y: 3n, expected: -8n },
	{ x: -6n, y: 3n, expected: -7n },
	{ x: -7n, y: -3n, expected: 4n },
])(
	"bigintBitwiseXOR handles negative numbers: $x ^ $y = $expected",
	({ x, y, expected }) => {
		const xValue = EngineValue.bigint(x);
		const yValue = EngineValue.bigint(y);
		const result = xValue.bigintBitwiseXOR(yValue);
		expect(result.data.value).toBe(expected);
	},
);

test.for([
	{ value: 10n, radix: 2, expected: "1010" },
	{ value: 10n, radix: 8, expected: "12" },
	{ value: 10n, radix: 10, expected: "10" },
	{ value: 10n, radix: 16, expected: "a" },
	{ value: 10n, radix: 36, expected: "a" },
	{ value: 0n, radix: 2, expected: "0" },
	{ value: 255n, radix: 16, expected: "ff" },
	{ value: 255n, radix: 2, expected: "11111111" },
])(
	"bigintToString handles positive numbers with radix $radix: $value = $expected",
	({ value, radix, expected }) => {
		const x = EngineValue.bigint(value);
		const result = x.bigintToString(radix);
		expect(result.data.value).toBe(expected);
	},
);

test.for([
	{ value: -10n, radix: 2, expected: "-1010" },
	{ value: -10n, radix: 16, expected: "-a" },
	{ value: -255n, radix: 16, expected: "-ff" },
	{ value: -1n, radix: 2, expected: "-1" },
])(
	"bigintToString handles negative numbers with radix $radix: $value = $expected",
	({ value, radix, expected }) => {
		const x = EngineValue.bigint(value);
		const result = x.bigintToString(radix);
		expect(result.data.value).toBe(expected);
	},
);
