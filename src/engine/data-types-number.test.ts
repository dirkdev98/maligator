import { expect, test } from "vitest";
import { EngineValue } from "./data-types.ts";

test("numberUnaryMinus negates positive numbers", () => {
	const number = EngineValue.number(42);
	const result = number.numberUnaryMinus();
	expect(result.data.value).toBe(-42);
});

test("numberUnaryMinus negates negative numbers", () => {
	const number = EngineValue.number(-42);
	const result = number.numberUnaryMinus();
	expect(result.data.value).toBe(42);
});

test("numberUnaryMinus returns NaN for NaN input", () => {
	const nan = EngineValue.number(NaN);
	const result = nan.numberUnaryMinus();
	expect(result.data.value).toBeNaN();
});

test("numberUnaryMinus handles Infinity correctly", () => {
	const infinity = EngineValue.number(Infinity);
	const result = infinity.numberUnaryMinus();
	expect(result.data.value).toBe(-Infinity);
});

test("numberUnaryMinus handles -Infinity correctly", () => {
	const negativeInfinity = EngineValue.number(-Infinity);
	const result = negativeInfinity.numberUnaryMinus();
	expect(result.data.value).toBe(Infinity);
});

test("numberUnaryMinus converts positive zero to negative zero and negative zero to positive zero", () => {
	const positiveZero = EngineValue.number(+0);
	const negativeZero = EngineValue.number(-0);

	const positiveResult = positiveZero.numberUnaryMinus();
	const negativeResult = negativeZero.numberUnaryMinus();

	expect(positiveResult.data.value).toBe(-0);
	expect(negativeResult.data.value).toBe(0);
});

test.for([
	{ input: 0, expected: -1 },
	{ input: 1, expected: -2 },
	{ input: -1, expected: 0 },
	{ input: 42, expected: -43 },
	{ input: -42, expected: 41 },
])("numberBitwiseNot returns bitwise complement: $input", ({ input, expected }) => {
	const number = EngineValue.number(input);
	const result = number.numberBitwiseNot();
	expect(result.data.value).toBe(expected);
});

test.for([
	{ input: 2147483647, expected: -2147483648 }, // 2^31 - 1
	{ input: -2147483648, expected: 2147483647 }, // -2^31
	// { input: 4294967295, expected: 0 }, // 2^32 - 1
	{ input: 4294967296, expected: -1 }, // 2^32
])("numberBitwiseNot handles 32-bit overflow for $input", ({ input, expected }) => {
	const number = EngineValue.number(input);
	const result = number.numberBitwiseNot();
	expect(result.data.value).toBe(expected);
});

test.for([
	{ input: 3.14, expected: -4 },
	// { input: -3.14, expected: 3 },
	{ input: 42.9, expected: -43 },
	{ input: -42.9, expected: 41 },
])(
	"numberBitwiseNot floors $input before applying bitwise complement",
	({ input, expected }) => {
		const number = EngineValue.number(input);
		const result = number.numberBitwiseNot();
		expect(result.data.value).toBe(expected);
	},
);

test.for([
	{ base: 2, exponent: 3, expected: 8 },
	{ base: 4, exponent: 0.5, expected: 2 },
	{ base: 10, exponent: 2, expected: 100 },
	{ base: 5, exponent: -1, expected: 0.2 },
])(
	"numberExponentiate handles integer, fractional, and negative exponents correctly for: $base ** $exponent",
	({ base, exponent, expected }) => {
		const baseValue = EngineValue.number(base);
		const exponentValue = EngineValue.number(exponent);
		const result = baseValue.numberExponentiate(exponentValue);
		expect(result.data.value).toBe(expected);
	},
);

test("numberExponentiate handles NaN exponent", () => {
	const base = EngineValue.number(42);
	const nanExponent = EngineValue.number(NaN);
	const result = base.numberExponentiate(nanExponent);
	expect(result.data.value).toBeNaN();
});

test.for([42, -42, 0, Infinity, -Infinity])(
	"numberExponentiate a zero-base with %o",
	(baseValue) => {
		const base = EngineValue.number(baseValue);
		const zeroExponent = EngineValue.number(0);
		const result = base.numberExponentiate(zeroExponent);
		expect(result.data.value).toBe(1);
	},
);

test("numberExponentiate handles NaN base", () => {
	const nanBase = EngineValue.number(NaN);
	const exponent = EngineValue.number(2);
	const result = nanBase.numberExponentiate(exponent);
	expect(result.data.value).toBeNaN();
});

test("numberExponentiate handles Infinity base with an positive exponent", () => {
	const infinity = EngineValue.number(Infinity);
	const positiveExponent = EngineValue.number(2);
	const result = infinity.numberExponentiate(positiveExponent);
	expect(result.data.value).toBe(Infinity);
});

test("numberExponentiate handles Infinity base with an negative exponent", () => {
	const infinity = EngineValue.number(Infinity);
	const negativeExponent = EngineValue.number(-2);
	const result = infinity.numberExponentiate(negativeExponent);
	expect(result.data.value).toBe(0);
});

test("numberExponentiate handles -Infinity base with odd positive exponent", () => {
	const negativeInfinity = EngineValue.number(-Infinity);
	const oddExponent = EngineValue.number(3);
	const result = negativeInfinity.numberExponentiate(oddExponent);
	expect(result.data.value).toBe(-Infinity);
});

test("numberExponentiate handles -Infinity base with even positive exponent", () => {
	const negativeInfinity = EngineValue.number(-Infinity);
	const evenExponent = EngineValue.number(2);
	const result = negativeInfinity.numberExponentiate(evenExponent);
	expect(result.data.value).toBe(Infinity);
});

test("numberExponentiate handles zero base with an positive exponent", () => {
	const zero = EngineValue.number(0);
	const positiveExponent = EngineValue.number(2);
	const result = zero.numberExponentiate(positiveExponent);
	expect(result.data.value).toBe(0);
});

test("numberExponentiate handles zero base with an negative exponent", () => {
	const zero = EngineValue.number(0);
	const negativeExponent = EngineValue.number(-2);
	const result = zero.numberExponentiate(negativeExponent);
	expect(result.data.value).toBe(Infinity);
});

test("numberExponentiate handles -0 base with even negative exponent", () => {
	const negativeZero = EngineValue.number(-0);
	const evenExponent = EngineValue.number(-2);
	const result = negativeZero.numberExponentiate(evenExponent);
	expect(result.data.value).toBe(Infinity);
});

test("numberExponentiate handles Infinity exponent with base > 1", () => {
	const base = EngineValue.number(2);
	const infinityExponent = EngineValue.number(Infinity);
	const result = base.numberExponentiate(infinityExponent);
	expect(result.data.value).toBe(Infinity);
});

test("numberExponentiate handles Infinity exponent with base = 1", () => {
	const base = EngineValue.number(1);
	const infinityExponent = EngineValue.number(Infinity);
	const result = base.numberExponentiate(infinityExponent);
	expect(result.data.value).toBeNaN();
});

test("numberExponentiate handles Infinity exponent with base < 1", () => {
	const base = EngineValue.number(0.5);
	const infinityExponent = EngineValue.number(Infinity);
	const result = base.numberExponentiate(infinityExponent);
	expect(result.data.value).toBe(0);
});

test("numberExponentiate handles -Infinity exponent with base > 1", () => {
	const base = EngineValue.number(2);
	const negativeInfinityExponent = EngineValue.number(-Infinity);
	const result = base.numberExponentiate(negativeInfinityExponent);
	expect(result.data.value).toBe(0);
});

test("numberExponentiate handles -Infinity exponent with base = 1", () => {
	const base = EngineValue.number(1);
	const negativeInfinityExponent = EngineValue.number(-Infinity);
	const result = base.numberExponentiate(negativeInfinityExponent);
	expect(result.data.value).toBeNaN();
});

test("numberExponentiate handles -Infinity exponent with base < 1", () => {
	const base = EngineValue.number(0.5);
	const negativeInfinityExponent = EngineValue.number(-Infinity);
	const result = base.numberExponentiate(negativeInfinityExponent);
	expect(result.data.value).toBe(Infinity);
});

test.for([
	{ x: 2, y: 3, expected: 6 },
	{ x: -2, y: 3, expected: -6 },
	{ x: 2, y: -3, expected: -6 },
	{ x: -2, y: -3, expected: 6 },
	{ x: 0, y: 5, expected: 0 },
	{ x: 5, y: 0, expected: 0 },
	{ x: 1.5, y: 2, expected: 3 },
	{ x: -1.5, y: 2, expected: -3 },
	{ x: 1.5, y: -2, expected: -3 },
])("numberMultiply handles sign rules: $x * $y = $expected", ({ x, y, expected }) => {
	const xValue = EngineValue.number(x);
	const yValue = EngineValue.number(y);
	const result = xValue.numberMultiply(yValue);
	expect(result.data.value).toBe(expected);
});

test("numberMultiply returns NaN when either operand is NaN", () => {
	const nan = EngineValue.number(NaN);
	const normal = EngineValue.number(42);

	expect(nan.numberMultiply(normal).data.value).toBeNaN();
	expect(normal.numberMultiply(nan).data.value).toBeNaN();
	expect(nan.numberMultiply(nan).data.value).toBeNaN();
});

test("numberMultiply handles Infinity * zero = NaN", () => {
	const infinity = EngineValue.number(Infinity);
	const positiveZero = EngineValue.number(+0);
	const negativeZero = EngineValue.number(-0);

	expect(infinity.numberMultiply(positiveZero).data.value).toBeNaN();
	expect(infinity.numberMultiply(negativeZero).data.value).toBeNaN();
	expect(EngineValue.number(-Infinity).numberMultiply(positiveZero).data.value).toBeNaN();
	expect(EngineValue.number(-Infinity).numberMultiply(negativeZero).data.value).toBeNaN();
});

test.for([
	{ infinity: Infinity, positive: 5, expected: Infinity },
	{ infinity: -Infinity, positive: 5, expected: -Infinity },
])(
	"numberMultiply preserves $infinity when multiplying by positive finite number",
	({ infinity, positive, expected }) => {
		const infinityValue = EngineValue.number(infinity);
		const positiveValue = EngineValue.number(positive);
		const result = infinityValue.numberMultiply(positiveValue);
		expect(result.data.value).toBe(expected);
	},
);

test.for([
	{ x: -0, y: -0, expected: +0 },
	{ x: -0, y: -5, expected: +0 },
	{ x: -0, y: 5, expected: -0 },
	{ x: -0, y: 0, expected: -0 },
])("numberMultiply handles negative zero sign: $x * $y", ({ x, y, expected }) => {
	const xValue = EngineValue.number(x);
	const yValue = EngineValue.number(y);
	const result = xValue.numberMultiply(yValue);
	expect(Object.is(result.data.value, expected)).toBe(true);
});

test.for([
	{ x: 0, y: -0, expected: -0 },
	{ x: 5, y: -0, expected: -0 },
])(
	"numberMultiply produces negative zero when multiplying $x by negative zero as second operand",
	({ x, y, expected }) => {
		const xValue = EngineValue.number(x);
		const yValue = EngineValue.number(y);
		const result = xValue.numberMultiply(yValue);
		expect(Object.is(result.data.value, expected)).toBe(true);
	},
);

test.for([
	{ x: 6, y: 3, expected: 2 },
	{ x: -6, y: 3, expected: -2 },
	{ x: 6, y: -3, expected: -2 },
	{ x: -6, y: -3, expected: 2 },
	{ x: 0, y: 5, expected: 0 },
	{ x: 5, y: 2, expected: 2.5 },
	{ x: -5, y: 2, expected: -2.5 },
	{ x: 5, y: -2, expected: -2.5 },
	{ x: -5, y: -2, expected: 2.5 },
])("numberDivide handles sign rules for $x / $y = $expected", ({ x, y, expected }) => {
	const xValue = EngineValue.number(x);
	const yValue = EngineValue.number(y);
	const result = xValue.numberDivide(yValue);
	expect(result.data.value).toBe(expected);
});

test("numberDivide returns NaN when either operand is NaN", () => {
	const nan = EngineValue.number(NaN);
	const normal = EngineValue.number(42);

	expect(nan.numberDivide(normal).data.value).toBeNaN();
	expect(normal.numberDivide(nan).data.value).toBeNaN();
	expect(nan.numberDivide(nan).data.value).toBeNaN();
});

test("numberDivide handles Infinity / Infinity = NaN", () => {
	const infinity = EngineValue.number(Infinity);
	const negativeInfinity = EngineValue.number(-Infinity);

	expect(infinity.numberDivide(infinity).data.value).toBeNaN();
	expect(infinity.numberDivide(negativeInfinity).data.value).toBeNaN();
	expect(negativeInfinity.numberDivide(infinity).data.value).toBeNaN();
	expect(negativeInfinity.numberDivide(negativeInfinity).data.value).toBeNaN();
});

test.for([
	{ infinity: Infinity, positive: 5, expected: Infinity },
	{ infinity: -Infinity, positive: 5, expected: -Infinity },
])(
	"numberDivide preserves $infinity when dividing by positive finite number",
	({ infinity, positive, expected }) => {
		const infinityValue = EngineValue.number(infinity);
		const positiveValue = EngineValue.number(positive);
		const result = infinityValue.numberDivide(positiveValue);
		expect(result.data.value).toBe(expected);
	},
);

test.for([
	{ x: 5, y: Infinity, expected: +0 },
	{ x: -5, y: Infinity, expected: -0 },
	{ x: 5, y: -Infinity, expected: -0 },
	{ x: -5, y: -Infinity, expected: +0 },
])(
	"numberDivide returns zero with correct sign when dividing $x by infinity",
	({ x, y, expected }) => {
		const xValue = EngineValue.number(x);
		const yValue = EngineValue.number(y);
		const result = xValue.numberDivide(yValue);
		expect(Object.is(result.data.value, expected)).toBe(true);
	},
);

test("numberDivide handles zero / zero = NaN", () => {
	const positiveZero = EngineValue.number(+0);
	const negativeZero = EngineValue.number(-0);

	expect(positiveZero.numberDivide(positiveZero).data.value).toBeNaN();
	expect(positiveZero.numberDivide(negativeZero).data.value).toBeNaN();
	expect(negativeZero.numberDivide(positiveZero).data.value).toBeNaN();
	expect(negativeZero.numberDivide(negativeZero).data.value).toBeNaN();
});

test.for([
	{ x: 5, y: 0, expected: Infinity },
	{ x: -5, y: 0, expected: -Infinity },
	{ x: 0, y: 5, expected: 0 },
])(
	"numberDivide returns infinity with sign when dividing with zero: $x / $y",
	({ x, y, expected }) => {
		const xValue = EngineValue.number(x);
		const yValue = EngineValue.number(y);
		const result = xValue.numberDivide(yValue);
		expect(result.data.value).toBe(expected);
	},
);

test.for([
	{ x: 5, y: -0, expected: -Infinity },
	{ x: -5, y: -0, expected: Infinity },
])(
	"numberDivide flips infinity sign when dividing by negative zero: $x / $y",
	({ x, y, expected }) => {
		const xValue = EngineValue.number(x);
		const yValue = EngineValue.number(y);
		const result = xValue.numberDivide(yValue);
		expect(result.data.value).toBe(expected);
	},
);

test.for([
	{ x: +0, y: -5, expected: -0 },
	{ x: +0, y: 5, expected: +0 },
	{ x: -0, y: -5, expected: +0 },
	{ x: -0, y: 5, expected: -0 },
])(
	"numberDivide preserves zero sign rules when dividing zero by non-zero: $x / $y",
	({ x, y, expected }) => {
		const xValue = EngineValue.number(x);
		const yValue = EngineValue.number(y);
		const result = xValue.numberDivide(yValue);

		expect(
			Object.is(result.data.value, expected),
			`${result.data.value}, ${expected}`,
		).toBe(true);
	},
);

test.for([
	{ dividend: 10, divisor: 3, expected: 1 },
	{ dividend: 10, divisor: -3, expected: 1 },
	{ dividend: -10, divisor: 3, expected: -1 },
	{ dividend: -10, divisor: -3, expected: -1 },
	{ dividend: 7, divisor: 2.5, expected: 2 },
	{ dividend: 0, divisor: 5, expected: 0 },
	{ dividend: 5, divisor: 1, expected: 0 },
])(
	"numberRemainder handles basic cases: $dividend % $divisor = $expected",
	({ dividend, divisor, expected }) => {
		const dividendValue = EngineValue.number(dividend);
		const divisorValue = EngineValue.number(divisor);
		const result = dividendValue.numberRemainder(divisorValue);
		expect(result.data.value).toBe(expected);
	},
);

test("numberRemainder returns NaN when either operand is NaN", () => {
	const nan = EngineValue.number(NaN);
	const normal = EngineValue.number(42);

	expect(nan.numberRemainder(normal).data.value).toBeNaN();
	expect(normal.numberRemainder(nan).data.value).toBeNaN();
	expect(nan.numberRemainder(nan).data.value).toBeNaN();
});

test("numberRemainder returns NaN when dividend is Infinity", () => {
	const infinity = EngineValue.number(Infinity);
	const negativeInfinity = EngineValue.number(-Infinity);
	const divisor = EngineValue.number(5);

	expect(infinity.numberRemainder(divisor).data.value).toBeNaN();
	expect(negativeInfinity.numberRemainder(divisor).data.value).toBeNaN();
});

test("numberRemainder returns dividend when divisor is Infinity", () => {
	const dividend = EngineValue.number(42);
	const negativeDividend = EngineValue.number(-42);
	const infinity = EngineValue.number(Infinity);
	const negativeInfinity = EngineValue.number(-Infinity);

	expect(dividend.numberRemainder(infinity).data.value).toBe(42);
	expect(dividend.numberRemainder(negativeInfinity).data.value).toBe(42);
	expect(negativeDividend.numberRemainder(infinity).data.value).toBe(-42);
	expect(negativeDividend.numberRemainder(negativeInfinity).data.value).toBe(-42);
});

test("numberRemainder returns NaN when divisor is zero", () => {
	const dividend = EngineValue.number(42);
	const positiveZero = EngineValue.number(+0);
	const negativeZero = EngineValue.number(-0);

	expect(dividend.numberRemainder(positiveZero).data.value).toBeNaN();
	expect(dividend.numberRemainder(negativeZero).data.value).toBeNaN();
});

test.for([
	{ dividend: 0, expected: 0 },
	{ dividend: -0, expected: -0 },
])(
	"numberRemainder returns dividend when dividend is zero: $dividend % 5 = $expected",
	({ dividend, expected }) => {
		const dividendValue = EngineValue.number(dividend);
		const divisor = EngineValue.number(5);
		const result = dividendValue.numberRemainder(divisor);

		if (Object.is(expected, -0)) {
			expect(Object.is(result.data.value, -0)).toBe(true);
		} else {
			// For expected 0, check that it's positive zero
			expect(result.data.value).toBe(0);
		}
	},
);

test("numberRemainder preserves negative zero in result when remainder is zero and dividend is negative", () => {
	const dividend = EngineValue.number(-10);
	const divisor = EngineValue.number(5);
	const result = dividend.numberRemainder(divisor);
	expect(Object.is(result.data.value, -0)).toBe(true);
});

test.for([
	{ dividend: 6, divisor: 4, expected: 2 },
	{ dividend: -6, divisor: 4, expected: -2 },
	{ dividend: 6, divisor: -4, expected: 2 },
	{ dividend: -6, divisor: -4, expected: -2 },
])(
	"numberRemainder follows truncating division remainder rule for $dividend % $divisor = $expected",
	({ dividend, divisor, expected }) => {
		const dividendValue = EngineValue.number(dividend);
		const divisorValue = EngineValue.number(divisor);
		const result = dividendValue.numberRemainder(divisorValue);
		expect(result.data.value).toBe(expected);
	},
);

test.for([
	{ x: 2, y: 3, expected: 5 },
	{ x: -2, y: 3, expected: 1 },
	{ x: 2, y: -3, expected: -1 },
	{ x: -2, y: -3, expected: -5 },
	{ x: 0, y: 5, expected: 5 },
	{ x: 5, y: 0, expected: 5 },
	{ x: 1.5, y: 2.5, expected: 4 },
	{ x: -1.5, y: 2.5, expected: 1 },
	{ x: 1.5, y: -2.5, expected: -1 },
	{ x: -1.5, y: -2.5, expected: -4 },
])("numberAdd handles basic cases: $x + $y = $expected", ({ x, y, expected }) => {
	const xValue = EngineValue.number(x);
	const yValue = EngineValue.number(y);
	const result = xValue.numberAdd(yValue);
	expect(result.data.value).toBe(expected);
});

test("numberAdd returns NaN when either operand is NaN", () => {
	const nan = EngineValue.number(NaN);
	const normal = EngineValue.number(42);

	expect(nan.numberAdd(normal).data.value).toBeNaN();
	expect(normal.numberAdd(nan).data.value).toBeNaN();
	expect(nan.numberAdd(nan).data.value).toBeNaN();
});

test("numberAdd handles Infinity + -Infinity = NaN", () => {
	const infinity = EngineValue.number(Infinity);
	const negativeInfinity = EngineValue.number(-Infinity);

	expect(infinity.numberAdd(negativeInfinity).data.value).toBeNaN();
	expect(negativeInfinity.numberAdd(infinity).data.value).toBeNaN();
});

test("numberAdd preserves Infinity when adding finite numbers", () => {
	const infinity = EngineValue.number(Infinity);
	const negativeInfinity = EngineValue.number(-Infinity);
	const positive = EngineValue.number(5);
	const negative = EngineValue.number(-5);

	expect(infinity.numberAdd(positive).data.value).toBe(Infinity);
	expect(infinity.numberAdd(negative).data.value).toBe(Infinity);
	expect(negativeInfinity.numberAdd(positive).data.value).toBe(-Infinity);
	expect(negativeInfinity.numberAdd(negative).data.value).toBe(-Infinity);
});

test("numberAdd preserves Infinity when both operands are Infinity with same sign", () => {
	const infinity = EngineValue.number(Infinity);
	const negativeInfinity = EngineValue.number(-Infinity);

	expect(infinity.numberAdd(infinity).data.value).toBe(Infinity);
	expect(negativeInfinity.numberAdd(negativeInfinity).data.value).toBe(-Infinity);
});

test.for([
	{ x: +0, y: +0, expected: 0 },
	{ x: -0, y: +0, expected: 0 },
	{ x: +0, y: -0, expected: 0 },
	{ x: -0, y: -0, expected: -0 },
])(
	"numberAdd handles zero addition correctly: $x + $y = $expected",
	({ x, y, expected }) => {
		const xValue = EngineValue.number(x);
		const yValue = EngineValue.number(y);
		const result = xValue.numberAdd(yValue);

		if (Object.is(expected, -0)) {
			expect(Object.is(result.data.value, -0)).toBe(true);
		} else {
			// For expected 0, check that it's positive zero
			expect(result.data.value).toBe(0);
		}
	},
);

test.for([
	{ x: 10, y: Infinity, expected: Infinity },
	{ x: -10, y: Infinity, expected: Infinity },
	{ x: 10, y: -Infinity, expected: -Infinity },
	{ x: -10, y: -Infinity, expected: -Infinity },
])(
	"numberAdd returns Infinity result when adding finite to Infinity: $x + $y = $expected",
	({ x, y, expected }) => {
		const xValue = EngineValue.number(x);
		const yValue = EngineValue.number(y);
		const result = xValue.numberAdd(yValue);
		expect(result.data.value).toBe(expected);
	},
);

test.for([
	{ x: 5, y: 3, expected: 2 },
	{ x: -5, y: 3, expected: -8 },
	{ x: 5, y: -3, expected: 8 },
	{ x: -5, y: -3, expected: -2 },
	{ x: 0, y: 5, expected: -5 },
	{ x: 5, y: 0, expected: 5 },
	{ x: 1.5, y: 0.5, expected: 1 },
	{ x: -1.5, y: 0.5, expected: -2 },
	{ x: 1.5, y: -0.5, expected: 2 },
	{ x: -1.5, y: -0.5, expected: -1 },
])("numberSubtract handles basic cases: $x - $y = $expected", ({ x, y, expected }) => {
	const xValue = EngineValue.number(x);
	const yValue = EngineValue.number(y);
	const result = xValue.numberSubtract(yValue);
	expect(result.data.value).toBe(expected);
});

test("numberSubtract returns NaN when either operand is NaN", () => {
	const nan = EngineValue.number(NaN);
	const normal = EngineValue.number(42);

	expect(nan.numberSubtract(normal).data.value).toBeNaN();
	expect(normal.numberSubtract(nan).data.value).toBeNaN();
	expect(nan.numberSubtract(nan).data.value).toBeNaN();
});

test("numberSubtract handles Infinity - Infinity = NaN", () => {
	const infinity = EngineValue.number(Infinity);
	const negativeInfinity = EngineValue.number(-Infinity);

	expect(infinity.numberSubtract(infinity).data.value).toBeNaN();
	expect(negativeInfinity.numberSubtract(negativeInfinity).data.value).toBeNaN();
});

test("numberSubtract handles Infinity subtraction rules", () => {
	const infinity = EngineValue.number(Infinity);
	const negativeInfinity = EngineValue.number(-Infinity);
	const positive = EngineValue.number(5);
	const negative = EngineValue.number(-5);

	expect(infinity.numberSubtract(positive).data.value).toBe(Infinity);
	expect(infinity.numberSubtract(negative).data.value).toBe(Infinity);
	expect(negativeInfinity.numberSubtract(positive).data.value).toBe(-Infinity);
	expect(negativeInfinity.numberSubtract(negative).data.value).toBe(-Infinity);
});

test("numberSubtract handles finite - Infinity rules", () => {
	const positive = EngineValue.number(5);
	const negative = EngineValue.number(-5);
	const infinity = EngineValue.number(Infinity);
	const negativeInfinity = EngineValue.number(-Infinity);

	expect(positive.numberSubtract(infinity).data.value).toBe(-Infinity);
	expect(negative.numberSubtract(infinity).data.value).toBe(-Infinity);
	expect(positive.numberSubtract(negativeInfinity).data.value).toBe(Infinity);
	expect(negative.numberSubtract(negativeInfinity).data.value).toBe(Infinity);
});

test.for([
	{ x: +0, y: +0, expected: 0 },
	{ x: -0, y: +0, expected: -0 },
	{ x: +0, y: -0, expected: 0 },
	{ x: -0, y: -0, expected: 0 },
])(
	"numberSubtract handles zero subtraction correctly: $x - $y = $expected",
	({ x, y, expected }) => {
		const xValue = EngineValue.number(x);
		const yValue = EngineValue.number(y);
		const result = xValue.numberSubtract(yValue);

		if (Object.is(expected, -0)) {
			expect(Object.is(result.data.value, -0)).toBe(true);
		} else {
			// For expected 0, check that it's positive zero
			expect(result.data.value).toBe(0);
		}
	},
);
