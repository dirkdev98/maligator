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

test.for([
	{ x: 1, y: 0, expected: 1 },
	{ x: 1, y: 1, expected: 2 },
	{ x: 1, y: 2, expected: 4 },
	{ x: 1, y: 3, expected: 8 },
	{ x: 2, y: 1, expected: 4 },
	{ x: 2, y: 2, expected: 8 },
	{ x: 4, y: 1, expected: 8 },
	{ x: 8, y: 2, expected: 32 },
	{ x: 16, y: 3, expected: 128 },
])(
	"numberLeftShift handles basic bit shifting: $x << $y = $expected",
	({ x, y, expected }) => {
		const xValue = EngineValue.number(x);
		const yValue = EngineValue.number(y);
		const result = xValue.numberLeftShift(yValue);
		expect(result.data.value).toBe(expected);
	},
);

test.for([
	{ x: -1, y: 0, expected: -1 },
	{ x: -1, y: 1, expected: -2 },
	{ x: -1, y: 2, expected: -4 },
	{ x: -1, y: 3, expected: -8 },
	{ x: -2, y: 1, expected: -4 },
	{ x: -4, y: 1, expected: -8 },
	{ x: -8, y: 2, expected: -32 },
])(
	"numberLeftShift handles negative numbers: $x << $y = $expected",
	({ x, y, expected }) => {
		const xValue = EngineValue.number(x);
		const yValue = EngineValue.number(y);
		const result = xValue.numberLeftShift(yValue);
		expect(result.data.value).toBe(expected);
	},
);

test.for([
	{ x: 1073741824, y: 1, expected: -2147483648 }, // 2^30 << 1 = 2^31 (most significant bit set)
	{ x: 1073741824, y: 2, expected: 0 }, // 2^30 << 2 = 2^32 = 0 (32-bit overflow)
	{ x: 2147483647, y: 1, expected: -2 }, // (2^31 - 1) << 1 = -2
	{ x: -2147483648, y: 1, expected: 0 }, // (-2^31) << 1 = 0
])(
	"numberLeftShift handles 32-bit signed overflow: $x << $y = $expected",
	({ x, y, expected }) => {
		const xValue = EngineValue.number(x);
		const yValue = EngineValue.number(y);
		const result = xValue.numberLeftShift(yValue);
		expect(result.data.value).toBe(expected);
	},
);

test.for([
	{ x: 1, y: 32, expected: 1 }, // 32 mod 32 = 0, so 1 << 0 = 1
	{ x: 1, y: 33, expected: 2 }, // 33 mod 32 = 1, so 1 << 1 = 2
	{ x: 1, y: 64, expected: 1 }, // 64 mod 32 = 0, so 1 << 0 = 1
	{ x: 1, y: 65, expected: 2 }, // 65 mod 32 = 1, so 1 << 1 = 2
	{ x: 2, y: 34, expected: 8 }, // 34 mod 32 = 2, so 2 << 2 = 8
])(
	"numberLeftShift handles shift counts >= 32 by modulo operation: $x << $y = $expected",
	({ x, y, expected }) => {
		const xValue = EngineValue.number(x);
		const yValue = EngineValue.number(y);
		const result = xValue.numberLeftShift(yValue);
		expect(result.data.value).toBe(expected);
	},
);

test.for([
	{ x: 3.14, y: 1, expected: 6 }, // 3 << 1 = 6
	{ x: -3.14, y: 1, expected: -6 }, // -3 << 1 = -6
	{ x: 5.9, y: 2, expected: 20 }, // 5 << 2 = 20
	{ x: 1, y: 2.9, expected: 4 }, // 1 << 2 = 4
])(
	"numberLeftShift floors operands before shifting: $x << $y = $expected",
	({ x, y, expected }) => {
		const xValue = EngineValue.number(x);
		const yValue = EngineValue.number(y);
		const result = xValue.numberLeftShift(yValue);
		expect(result.data.value).toBe(expected);
	},
);

test.for([
	{ x: NaN, y: 1, expected: 0 }, // toInt32(NaN) = 0
	{ x: 1, y: NaN, expected: 1 }, // toUint32(NaN) = 0, so 1 << 0 = 1
	{ x: Infinity, y: 1, expected: 0 }, // toInt32(Infinity) = 0
	{ x: 1, y: Infinity, expected: 1 }, // toUint32(Infinity) = 0, so 1 << 0 = 1
])("numberLeftShift handles special values: $x << $y", ({ x, y, expected }) => {
	const xValue = EngineValue.number(x);
	const yValue = EngineValue.number(y);
	const result = xValue.numberLeftShift(yValue);
	expect(result.data.value).toBe(expected);
});

test.for([
	{ x: 8, y: 1, expected: 4 },
	{ x: 8, y: 2, expected: 2 },
	{ x: 8, y: 3, expected: 1 },
	{ x: 16, y: 1, expected: 8 },
	{ x: 16, y: 2, expected: 4 },
	{ x: 32, y: 3, expected: 4 },
	{ x: 64, y: 4, expected: 4 },
])(
	"numberSignedRightShift handles basic positive numbers: $x >> $y = $expected",
	({ x, y, expected }) => {
		const xValue = EngineValue.number(x);
		const yValue = EngineValue.number(y);
		const result = xValue.numberSignedRightShift(yValue);
		expect(result.data.value).toBe(expected);
	},
);

test.for([
	{ x: -8, y: 1, expected: -4 },
	{ x: -8, y: 2, expected: -2 },
	{ x: -8, y: 3, expected: -1 },
	{ x: -16, y: 1, expected: -8 },
	{ x: -16, y: 2, expected: -4 },
	{ x: -32, y: 3, expected: -4 },
	{ x: -1, y: 1, expected: -1 }, // -1 stays -1 due to sign extension
	{ x: -1, y: 31, expected: -1 }, // -1 stays -1 due to sign extension
])(
	"numberSignedRightShift handles negative numbers with sign extension: $x >> $y = $expected",
	({ x, y, expected }) => {
		const xValue = EngineValue.number(x);
		const yValue = EngineValue.number(y);
		const result = xValue.numberSignedRightShift(yValue);
		expect(result.data.value).toBe(expected);
	},
);

test.for([
	{ x: 1073741824, y: 1, expected: 536870912 }, // 2^30 >> 1 = 2^29
	{ x: -2147483648, y: 1, expected: -1073741824 }, // -2^31 >> 1 = -2^30
	{ x: -2147483648, y: 31, expected: -1 }, // -2^31 >> 31 = -1 (sign extension)
	{ x: 2147483647, y: 1, expected: 1073741823 }, // (2^31 - 1) >> 1 = 2^30 - 1
])(
	"numberSignedRightShift handles 32-bit signed edge cases: $x >> $y = $expected",
	({ x, y, expected }) => {
		const xValue = EngineValue.number(x);
		const yValue = EngineValue.number(y);
		const result = xValue.numberSignedRightShift(yValue);
		expect(result.data.value).toBe(expected);
	},
);

test.for([
	{ x: 8, y: 32, expected: 8 }, // 32 mod 32 = 0, so 8 >> 0 = 8
	{ x: 8, y: 33, expected: 4 }, // 33 mod 32 = 1, so 8 >> 1 = 4
	{ x: 8, y: 64, expected: 8 }, // 64 mod 32 = 0, so 8 >> 0 = 8
	{ x: -8, y: 32, expected: -8 }, // 32 mod 32 = 0, so -8 >> 0 = -8
	{ x: -8, y: 33, expected: -4 }, // 33 mod 32 = 1, so -8 >> 1 = -4
])(
	"numberSignedRightShift handles shift counts >= 32 by modulo operation: $x >> $y = $expected",
	({ x, y, expected }) => {
		const xValue = EngineValue.number(x);
		const yValue = EngineValue.number(y);
		const result = xValue.numberSignedRightShift(yValue);
		expect(result.data.value).toBe(expected);
	},
);

test.for([
	{ x: 12.7, y: 1, expected: 6 }, // 12 >> 1 = 6
	{ x: -12.7, y: 1, expected: -6 }, // -12 >> 1 = -6
	{ x: 8, y: 1.9, expected: 4 }, // 8 >> 1 = 4
])(
	"numberSignedRightShift floors operands before shifting: $x >> $y = $expected",
	({ x, y, expected }) => {
		const xValue = EngineValue.number(x);
		const yValue = EngineValue.number(y);
		const result = xValue.numberSignedRightShift(yValue);
		expect(result.data.value).toBe(expected);
	},
);

test.for([
	{ x: NaN, y: 1, expected: 0 }, // toInt32(NaN) = 0
	{ x: 1, y: NaN, expected: 1 }, // toUint32(NaN) = 0, so 1 >> 0 = 1
	{ x: Infinity, y: 1, expected: 0 }, // toInt32(Infinity) = 0
	{ x: 1, y: Infinity, expected: 1 }, // toUint32(Infinity) = 0, so 1 >> 0 = 1
])("numberSignedRightShift handles special values: $x >> $y", ({ x, y, expected }) => {
	const xValue = EngineValue.number(x);
	const yValue = EngineValue.number(y);
	const result = xValue.numberSignedRightShift(yValue);
	expect(result.data.value).toBe(expected);
});

test.for([
	{ x: 8, y: 1, expected: 4 },
	{ x: 8, y: 2, expected: 2 },
	{ x: 8, y: 3, expected: 1 },
	{ x: 16, y: 1, expected: 8 },
	{ x: 16, y: 2, expected: 4 },
	{ x: 32, y: 3, expected: 4 },
	{ x: 64, y: 4, expected: 4 },
])(
	"numberUnsignedRightShift handles basic positive numbers: $x >>> $y = $expected",
	({ x, y, expected }) => {
		const xValue = EngineValue.number(x);
		const yValue = EngineValue.number(y);
		const result = xValue.numberUnsignedRightShift(yValue);
		expect(result.data.value).toBe(expected);
	},
);

test.for([
	{ x: -1, y: 0, expected: 4294967295 }, // -1 >>> 0 = 0xFFFFFFFF
	{ x: -1, y: 1, expected: 2147483647 }, // -1 >>> 1 = 0x7FFFFFFF
	{ x: -1, y: 2, expected: 1073741823 }, // -1 >>> 2 = 0x3FFFFFFF
	{ x: -1, y: 31, expected: 1 }, // -1 >>> 31 = 0x00000001
	{ x: -1, y: 32, expected: 4294967295 }, // -1 >>> 32 = -1 >>> 0 = 0xFFFFFFFF
	{ x: -2, y: 1, expected: 2147483647 }, // -2 >>> 1 = 0x7FFFFFFF
	{ x: -2, y: 2, expected: 1073741823 }, // -2 >>> 2 = 0x3FFFFFFF
	{ x: -8, y: 1, expected: 2147483644 }, // -8 >>> 1 = 0x7FFFFFFC
	{ x: -8, y: 2, expected: 1073741822 }, // -8 >>> 2 = 0x3FFFFFFE
])(
	"numberUnsignedRightShift handles negative numbers with zero fill: $x >>> $y = $expected",
	({ x, y, expected }) => {
		const xValue = EngineValue.number(x);
		const yValue = EngineValue.number(y);
		const result = xValue.numberUnsignedRightShift(yValue);
		expect(result.data.value).toBe(expected);
	},
);

test.for([
	{ x: 1073741824, y: 1, expected: 536870912 }, // 2^30 >>> 1 = 2^29
	{ x: -2147483648, y: 1, expected: 1073741824 }, // -2^31 >>> 1 = 2^30
	{ x: -2147483648, y: 0, expected: 2147483648 }, // -2^31 >>> 0 = 2^31 (unsigned interpretation)
	{ x: 2147483647, y: 1, expected: 1073741823 }, // (2^31 - 1) >>> 1 = 2^30 - 1
	{ x: -2, y: 31, expected: 1 }, // -2 >>> 31 = 1
])(
	"numberUnsignedRightShift handles 32-bit signed/unsigned edge cases: $x >>> $y = $expected",
	({ x, y, expected }) => {
		const xValue = EngineValue.number(x);
		const yValue = EngineValue.number(y);
		const result = xValue.numberUnsignedRightShift(yValue);
		expect(result.data.value).toBe(expected);
	},
);

test.for([
	{ x: 8, y: 32, expected: 8 }, // 32 mod 32 = 0, so 8 >>> 0 = 8
	{ x: 8, y: 33, expected: 4 }, // 33 mod 32 = 1, so 8 >>> 1 = 4
	{ x: 8, y: 64, expected: 8 }, // 64 mod 32 = 0, so 8 >>> 0 = 8
	{ x: -8, y: 32, expected: 4294967288 }, // 32 mod 32 = 0, so -8 >>> 0 = 4294967288
	{ x: -8, y: 33, expected: 2147483644 }, // 33 mod 32 = 1, so -8 >>> 1 = 2147483644
])(
	"numberUnsignedRightShift handles shift counts >= 32 by modulo operation: $x >>> $y = $expected",
	({ x, y, expected }) => {
		const xValue = EngineValue.number(x);
		const yValue = EngineValue.number(y);
		const result = xValue.numberUnsignedRightShift(yValue);
		expect(result.data.value).toBe(expected);
	},
);

test.for([
	{ x: 12.7, y: 1, expected: 6 }, // 12 >>> 1 = 6
	{ x: -12.7, y: 1, expected: 2147483642 }, // -12 >>> 1 = 2147483642
	{ x: 8, y: 1.9, expected: 4 }, // 8 >>> 1 = 4
])(
	"numberUnsignedRightShift floors operands before shifting: $x >>> $y = $expected",
	({ x, y, expected }) => {
		const xValue = EngineValue.number(x);
		const yValue = EngineValue.number(y);
		const result = xValue.numberUnsignedRightShift(yValue);
		expect(result.data.value).toBe(expected);
	},
);

test.for([
	{ x: NaN, y: 1, expected: 0 }, // toInt32(NaN) = 0
	{ x: 1, y: NaN, expected: 1 }, // toUint32(NaN) = 0, so 1 >>> 0 = 1
	{ x: Infinity, y: 1, expected: 0 }, // toInt32(Infinity) = 0
	{ x: 1, y: Infinity, expected: 1 }, // toUint32(Infinity) = 0, so 1 >>> 0 = 1
])("numberUnsignedRightShift handles special values: $x >>> $y", ({ x, y, expected }) => {
	const xValue = EngineValue.number(x);
	const yValue = EngineValue.number(y);
	const result = xValue.numberUnsignedRightShift(yValue);
	expect(result.data.value).toBe(expected);
});

// === COMPARISON OPERATIONS ===

test.for([
	{ x: 1, y: 2, expected: true },
	{ x: -1, y: 0, expected: true },
	{ x: 0, y: 1, expected: true },
	{ x: -5, y: -3, expected: true },
	{ x: -10, y: -5, expected: true },
	{ x: 1.5, y: 2.5, expected: true },
	{ x: -1.5, y: -0.5, expected: true },
])("numberLessThan returns true for $x < $y", ({ x, y, expected }) => {
	const xValue = EngineValue.number(x);
	const yValue = EngineValue.number(y);
	const result = xValue.numberLessThan(yValue);
	expect(result.isBoolean()).toBe(true);
	if (result.isBoolean()) {
		expect(result.data.value).toBe(expected);
	}
});

test.for([
	{ x: 1, y: 1, expected: false },
	{ x: 0, y: 0, expected: false },
	{ x: -1, y: -1, expected: false },
	{ x: 2, y: 1, expected: false },
	{ x: 5, y: -3, expected: false },
	{ x: -1, y: -2, expected: false },
	{ x: 3.14, y: 3.14, expected: false },
])(
	"numberLessThan returns false for non-less comparisons: $x < $y",
	({ x, y, expected }) => {
		const xValue = EngineValue.number(x);
		const yValue = EngineValue.number(y);
		const result = xValue.numberLessThan(yValue);
		expect(result.isBoolean()).toBe(true);
		if (result.isBoolean()) {
			expect(result.data.value).toBe(expected);
		}
	},
);

test("numberLessThan handles NaN comparisons correctly", () => {
	const nan = EngineValue.number(NaN);
	const normal = EngineValue.number(42);
	const zero = EngineValue.number(0);
	const infinity = EngineValue.number(Infinity);

	// NaN compared with anything returns undefined
	expect(nan.numberLessThan(normal).isUndefined()).toBe(true);
	expect(normal.numberLessThan(nan).isUndefined()).toBe(true);
	expect(nan.numberLessThan(nan).isUndefined()).toBe(true);
	expect(nan.numberLessThan(zero).isUndefined()).toBe(true);
	expect(nan.numberLessThan(infinity).isUndefined()).toBe(true);
});

test.for([
	{ x: NaN, y: Infinity },
	{ x: Infinity, y: NaN },
	{ x: -Infinity, y: NaN },
	{ x: NaN, y: -Infinity },
])(
	"numberLessThan returns undefined for NaN comparisons with Infinity: $x < $y",
	({ x, y }) => {
		const xValue = EngineValue.number(x);
		const yValue = EngineValue.number(y);
		const result = xValue.numberLessThan(yValue);
		expect(result.isUndefined()).toBe(true);
	},
);

test.for([
	{ x: 42, y: Infinity, expected: true },
	{ x: -42, y: Infinity, expected: true },
	{ x: -Infinity, y: 42, expected: true },
	{ x: -Infinity, y: Infinity, expected: true },
	{ x: Number.MAX_VALUE, y: Infinity, expected: true },
	{ x: -Infinity, y: Number.MIN_VALUE, expected: true },
])("numberLessThan handles Infinity comparisons: $x < $y", ({ x, y, expected }) => {
	const xValue = EngineValue.number(x);
	const yValue = EngineValue.number(y);
	const result = xValue.numberLessThan(yValue);
	expect(result.isBoolean()).toBe(true);
	if (result.isBoolean()) {
		expect(result.data.value).toBe(expected);
	}
});

test.for([
	{ x: Infinity, y: 42, expected: false },
	{ x: Infinity, y: -42, expected: false },
	{ x: 42, y: -Infinity, expected: false },
	{ x: Infinity, y: -Infinity, expected: false },
	{ x: Infinity, y: Number.MAX_VALUE, expected: false },
	{ x: Number.MIN_VALUE, y: -Infinity, expected: false },
])(
	"numberLessThan handles reverse Infinity comparisons: $x < $y",
	({ x, y, expected }) => {
		const xValue = EngineValue.number(x);
		const yValue = EngineValue.number(y);
		const result = xValue.numberLessThan(yValue);
		expect(result.isBoolean()).toBe(true);
		if (result.isBoolean()) {
			expect(result.data.value).toBe(expected);
		}
	},
);

test.for([
	{ x: -0, y: +0, expected: false },
	{ x: +0, y: -0, expected: false },
	{ x: -0, y: -0, expected: false },
	{ x: +0, y: +0, expected: false },
])("numberLessThan handles zero sign comparisons: $x < $y", ({ x, y, expected }) => {
	const xValue = EngineValue.number(x);
	const yValue = EngineValue.number(y);
	const result = xValue.numberLessThan(yValue);
	expect(result.isBoolean()).toBe(true);
	if (result.isBoolean()) {
		expect(result.data.value).toBe(expected);
	}
});

test.for([
	{ x: 1, y: 1, expected: true },
	{ x: 0, y: 0, expected: true },
	{ x: -1, y: -1, expected: true },
	{ x: 42, y: 42, expected: true },
	{ x: 3.14, y: 3.14, expected: true },
	{ x: -42, y: -42, expected: true },
	{ x: Infinity, y: Infinity, expected: true },
	{ x: -Infinity, y: -Infinity, expected: true },
])("numberEqual returns true for identical values: $x === $y", ({ x, y, expected }) => {
	const xValue = EngineValue.number(x);
	const yValue = EngineValue.number(y);
	const result = xValue.numberEqual(yValue);
	expect(result.isBoolean()).toBe(true);
	if (result.isBoolean()) {
		expect(result.data.value).toBe(expected);
	}
});

test.for([
	{ x: 1, y: 2, expected: false },
	{ x: 0, y: -0, expected: true }, // === treats -0 as equal to 0
	{ x: -0, y: 0, expected: true }, // === treats -0 as equal to 0
	{ x: 42, y: -42, expected: false },
	{ x: Infinity, y: -Infinity, expected: false },
	{ x: 3.14, y: 3.14159, expected: false },
])("numberEqual handles inequality cases: $x === $y", ({ x, y, expected }) => {
	const xValue = EngineValue.number(x);
	const yValue = EngineValue.number(y);
	const result = xValue.numberEqual(yValue);
	expect(result.isBoolean()).toBe(true);
	if (result.isBoolean()) {
		expect(result.data.value).toBe(expected);
	}
});

test("numberEqual handles NaN comparisons correctly", () => {
	const nan = EngineValue.number(NaN);
	const normal = EngineValue.number(42);
	const zero = EngineValue.number(0);
	const infinity = EngineValue.number(Infinity);

	// NaN compared with anything is false (even NaN === NaN)
	expect(nan.numberEqual(normal).data.value).toBe(false);
	expect(normal.numberEqual(nan).data.value).toBe(false);
	expect(nan.numberEqual(nan).data.value).toBe(false);
	expect(nan.numberEqual(zero).data.value).toBe(false);
	expect(nan.numberEqual(infinity).data.value).toBe(false);
});

test.for([
	{ x: 1, y: 1, expected: true },
	{ x: 0, y: 0, expected: true },
	{ x: -1, y: -1, expected: true },
	{ x: 42, y: 42, expected: true },
	{ x: 3.14, y: 3.14, expected: true },
	{ x: -42, y: -42, expected: true },
	{ x: Infinity, y: Infinity, expected: true },
	{ x: -Infinity, y: -Infinity, expected: true },
])(
	"numberSameValue returns true for identical values: Object.is($x, $y)",
	({ x, y, expected }) => {
		const xValue = EngineValue.number(x);
		const yValue = EngineValue.number(y);
		const result = xValue.numberSameValue(yValue);
		expect(result.isBoolean()).toBe(true);
		if (result.isBoolean()) {
			expect(result.data.value).toBe(expected);
		}
	},
);

test("numberSameValue handles NaN correctly (Object.is semantics)", () => {
	const nan1 = EngineValue.number(NaN);
	const nan2 = EngineValue.number(0 / 0); // Different NaN source
	const normal = EngineValue.number(42);

	// Object.is(NaN, NaN) === true
	expect(nan1.numberSameValue(nan2).data.value).toBe(true);
	expect(nan1.numberSameValue(nan1).data.value).toBe(true);
	expect(nan2.numberSameValue(nan2).data.value).toBe(true);

	// NaN compared with non-NaN is false
	expect(nan1.numberSameValue(normal).data.value).toBe(false);
	expect(normal.numberSameValue(nan1).data.value).toBe(false);
});

test.for([
	{ x: -0, y: +0, expected: false },
	{ x: +0, y: -0, expected: false },
])(
	"numberSameValue distinguishes negative zero: Object.is($x, $y)",
	({ x, y, expected }) => {
		const xValue = EngineValue.number(x);
		const yValue = EngineValue.number(y);
		const result = xValue.numberSameValue(yValue);
		expect(result.isBoolean()).toBe(true);
		if (result.isBoolean()) {
			expect(result.data.value).toBe(expected);
		}
	},
);

test.for([
	{ x: 1, y: 1, expected: true },
	{ x: 0, y: 0, expected: true },
	{ x: -1, y: -1, expected: true },
	{ x: 42, y: 42, expected: true },
	{ x: 3.14, y: 3.14, expected: true },
	{ x: -42, y: -42, expected: true },
	{ x: Infinity, y: Infinity, expected: true },
	{ x: -Infinity, y: -Infinity, expected: true },
])(
	"numberSameValueZero returns true for identical values: SameValueZero($x, $y)",
	({ x, y, expected }) => {
		const xValue = EngineValue.number(x);
		const yValue = EngineValue.number(y);
		const result = xValue.numberSameValueZero(yValue);
		expect(result.isBoolean()).toBe(true);
		if (result.isBoolean()) {
			expect(result.data.value).toBe(expected);
		}
	},
);

test("numberSameValueZero handles NaN correctly (SameValueZero semantics)", () => {
	const nan1 = EngineValue.number(NaN);
	const nan2 = EngineValue.number(0 / 0); // Different NaN source
	const normal = EngineValue.number(42);

	// SameValueZero(NaN, NaN) === true (like Map/Set key equality)
	expect(nan1.numberSameValueZero(nan2).data.value).toBe(true);
	expect(nan1.numberSameValueZero(nan1).data.value).toBe(true);
	expect(nan2.numberSameValueZero(nan2).data.value).toBe(true);

	// NaN compared with non-NaN is false
	expect(nan1.numberSameValueZero(normal).data.value).toBe(false);
	expect(normal.numberSameValueZero(nan1).data.value).toBe(false);
});

test.for([
	{ x: -0, y: +0, expected: true },
	{ x: +0, y: -0, expected: true },
	{ x: -0, y: -0, expected: true },
	{ x: +0, y: +0, expected: true },
])(
	"numberSameValueZero treats all zeros as equal: SameValueZero($x, $y)",
	({ x, y, expected }) => {
		const xValue = EngineValue.number(x);
		const yValue = EngineValue.number(y);
		const result = xValue.numberSameValueZero(yValue);
		expect(result.isBoolean()).toBe(true);
		if (result.isBoolean()) {
			expect(result.data.value).toBe(expected);
		}
	},
);

// === BITWISE OPERATIONS ===

test.for([
	{ x: 5, y: 3, expected: 1 }, // 0101 & 0011 = 0001
	{ x: 12, y: 10, expected: 8 }, // 1100 & 1010 = 1000
	{ x: 15, y: 0, expected: 0 }, // 1111 & 0000 = 0000
	{ x: 8, y: 8, expected: 8 }, // 1000 & 1000 = 1000
	{ x: 255, y: 15, expected: 15 }, // 11111111 & 00001111 = 00001111
	{ x: 1023, y: 511, expected: 511 }, // 1111111111 & 0111111111 = 0111111111
])("numberBitwiseAND handles basic cases: $x & $y = $expected", ({ x, y, expected }) => {
	const xValue = EngineValue.number(x);
	const yValue = EngineValue.number(y);
	const result = xValue.numberBitwiseAND(yValue);
	expect(result.data.value).toBe(expected);
});

test.for([
	{ x: -5, y: 3, expected: 3 }, // -5 & 3 (two's complement)
	{ x: -1, y: 1, expected: 1 }, // -1 & 1 = 1 (all bits set & 0001 = 0001)
	{ x: -8, y: 7, expected: 0 }, // -8 & 7 = 0
	{ x: -2, y: -3, expected: -4 }, // -2 & -3 = -4
	{ x: -1, y: -1, expected: -1 }, // -1 & -1 = -1 (all bits set)
])(
	"numberBitwiseAND handles negative numbers: $x & $y = $expected",
	({ x, y, expected }) => {
		const xValue = EngineValue.number(x);
		const yValue = EngineValue.number(y);
		const result = xValue.numberBitwiseAND(yValue);
		expect(result.data.value).toBe(expected);
	},
);

test.for([
	{ x: 0, y: 5, expected: 0 }, // 0 & anything = 0
	{ x: 5, y: 0, expected: 0 }, // anything & 0 = 0
	{ x: 0, y: 0, expected: 0 }, // 0 & 0 = 0
	{ x: 0, y: -1, expected: 0 }, // 0 & -1 = 0
])(
	"numberBitwiseAND handles zero operands: $x & $y = $expected",
	({ x, y, expected }) => {
		const xValue = EngineValue.number(x);
		const yValue = EngineValue.number(y);
		const result = xValue.numberBitwiseAND(yValue);
		expect(result.data.value).toBe(expected);
	},
);

test.for([
	{ x: 5, y: 3, expected: 6 }, // 0101 ^ 0011 = 0110
	{ x: 12, y: 10, expected: 6 }, // 1100 ^ 1010 = 0110
	{ x: 15, y: 0, expected: 15 }, // 1111 ^ 0000 = 1111
	{ x: 8, y: 8, expected: 0 }, // 1000 ^ 1000 = 0000
	{ x: 255, y: 15, expected: 240 }, // 11111111 ^ 00001111 = 11110000
])("numberBitwiseXOR handles basic cases: $x ^ $y = $expected", ({ x, y, expected }) => {
	const xValue = EngineValue.number(x);
	const yValue = EngineValue.number(y);
	const result = xValue.numberBitwiseXOR(yValue);
	expect(result.data.value).toBe(expected);
});

test.for([
	{ x: -5, y: 3, expected: -8 }, // -5 ^ 3
	{ x: -1, y: 1, expected: -2 }, // -1 ^ 1 = -2
	{ x: -8, y: 7, expected: -1 }, // -8 ^ 7 = -1
	{ x: -2, y: -3, expected: 3 }, // -2 ^ -3 = 3
	{ x: -1, y: -1, expected: 0 }, // -1 ^ -1 = 0
])(
	"numberBitwiseXOR handles negative numbers: $x ^ $y = $expected",
	({ x, y, expected }) => {
		const xValue = EngineValue.number(x);
		const yValue = EngineValue.number(y);
		const result = xValue.numberBitwiseXOR(yValue);
		expect(result.data.value).toBe(expected);
	},
);

test.for([
	{ x: 5, y: 3, expected: 7 }, // 0101 | 0011 = 0111
	{ x: 12, y: 10, expected: 14 }, // 1100 | 1010 = 1110
	{ x: 15, y: 0, expected: 15 }, // 1111 | 0000 = 1111
	{ x: 8, y: 8, expected: 8 }, // 1000 | 1000 = 1000
	{ x: 255, y: 15, expected: 255 }, // 11111111 | 00001111 = 11111111
])("numberBitwiseOR handles basic cases: $x | $y = $expected", ({ x, y, expected }) => {
	const xValue = EngineValue.number(x);
	const yValue = EngineValue.number(y);
	const result = xValue.numberBitwiseOR(yValue);
	expect(result.data.value).toBe(expected);
});

test.for([
	{ x: -5, y: 3, expected: -5 }, // -5 | 3 = -5
	{ x: -1, y: 1, expected: -1 }, // -1 | 1 = -1 (all bits set)
	{ x: -8, y: 7, expected: -1 }, // -8 | 7 = -1 (all bits set)
	{ x: -2, y: -3, expected: -1 }, // -2 | -3 = -1
	{ x: -1, y: -1, expected: -1 }, // -1 | -1 = -1 (all bits set)
])(
	"numberBitwiseOR handles negative numbers: $x | $y = $expected",
	({ x, y, expected }) => {
		const xValue = EngineValue.number(x);
		const yValue = EngineValue.number(y);
		const result = xValue.numberBitwiseOR(yValue);
		expect(result.data.value).toBe(expected);
	},
);

test.for([
	{ x: NaN, y: 5, expected: 0 }, // NaN becomes 0 via toInt32
	{ x: 5, y: NaN, expected: 0 }, // NaN becomes 0 via toInt32, so 5 & 0 = 0
	{ x: Infinity, y: 1, expected: 0 }, // Infinity becomes 0 via toInt32
	{ x: 1, y: Infinity, expected: 0 }, // Infinity becomes 0 via toInt32, so 1 & 0 = 0
	{ x: NaN, y: NaN, expected: 0 }, // Both become 0
])(
	"numberBitwiseAND handles special values: $x & $y = $expected",
	({ x, y, expected }) => {
		const xValue = EngineValue.number(x);
		const yValue = EngineValue.number(y);
		const result = xValue.numberBitwiseAND(yValue);
		expect(result.data.value).toBe(expected);
	},
);

test.for([
	{ x: NaN, y: 5, expected: 5 }, // NaN becomes 0 via toInt32
	{ x: 5, y: NaN, expected: 5 }, // NaN becomes 0 via toInt32, so 5 ^ 0 = 5
	{ x: Infinity, y: 1, expected: 1 }, // Infinity becomes 0 via toInt32
	{ x: 1, y: Infinity, expected: 1 }, // Infinity becomes 0 via toInt32, so 1 ^ 0 = 1
	{ x: NaN, y: NaN, expected: 0 }, // Both become 0
])(
	"numberBitwiseXOR handles special values: $x ^ $y = $expected",
	({ x, y, expected }) => {
		const xValue = EngineValue.number(x);
		const yValue = EngineValue.number(y);
		const result = xValue.numberBitwiseXOR(yValue);
		expect(result.data.value).toBe(expected);
	},
);

test.for([
	{ x: NaN, y: 5, expected: 5 }, // NaN becomes 0 via toInt32
	{ x: 5, y: NaN, expected: 5 }, // NaN becomes 0 via toInt32, so 5 | 0 = 5
	{ x: Infinity, y: 1, expected: 1 }, // Infinity becomes 0 via toInt32
	{ x: 1, y: Infinity, expected: 1 }, // Infinity becomes 0 via toInt32, so 1 | 0 = 1
	{ x: NaN, y: NaN, expected: 0 }, // Both become 0
])(
	"numberBitwiseOR handles special values: $x | $y = $expected",
	({ x, y, expected }) => {
		const xValue = EngineValue.number(x);
		const yValue = EngineValue.number(y);
		const result = xValue.numberBitwiseOR(yValue);
		expect(result.data.value).toBe(expected);
	},
);

test.for([
	{ x: 3.14, y: 1, expected: 3 }, // 3 | 1 = 3 (3.14 floors to 3)
	{ x: 5.9, y: 2, expected: 7 }, // 5 | 2 = 7 (5.9 floors to 5)
	{ x: 1, y: 2.9, expected: 3 }, // 1 | 2 = 3 (2.9 floors to 2)
	{ x: -3.14, y: 1, expected: -3 }, // -3 | 1 = -3 (-3.14 floors to -3)
	{ x: -5.9, y: 2, expected: -5 }, // -5 | 2 = -7 (-5.9 floors to -5)
])(
	"numberBitwiseOR floors operands before operation: $x | $y = $expected",
	({ x, y, expected }) => {
		const xValue = EngineValue.number(x);
		const yValue = EngineValue.number(y);
		const result = xValue.numberBitwiseOR(yValue);
		expect(result.data.value).toBe(expected);
	},
);

test.for([
	{ x: 3.14, y: 1, expected: 2 }, // 3 ^ 1 = 2 (3.14 floors to 3)
	{ x: 5.9, y: 2, expected: 7 }, // 5 ^ 2 = 7 (5.9 floors to 5)
	{ x: 1, y: 2.9, expected: 3 }, // 1 ^ 2 = 3 (2.9 floors to 2)
	{ x: -3.14, y: 1, expected: -4 }, // -3 ^ 1 = -4 (-3.14 floors to -3)
	{ x: -5.9, y: 2, expected: -7 }, // -5 ^ 2 = -7 (-5.9 floors to -5)
])(
	"numberBitwiseXOR floors operands before operation: $x ^ $y = $expected",
	({ x, y, expected }) => {
		const xValue = EngineValue.number(x);
		const yValue = EngineValue.number(y);
		const result = xValue.numberBitwiseXOR(yValue);
		expect(result.data.value).toBe(expected);
	},
);

test.for([
	{ x: 3.14, y: 1, expected: 1 }, // 3 & 1 = 1 (3.14 floors to 3)
	{ x: 5.9, y: 2, expected: 0 }, // 5 & 2 = 0 (5.9 floors to 5)
	{ x: 1, y: 2.9, expected: 0 }, // 1 & 2 = 0 (2.9 floors to 2)
	{ x: -3.14, y: 1, expected: 1 }, // -3 & 1 = 1 (-3.14 floors to -3)
	{ x: -5.9, y: 2, expected: 2 }, // -5 & 2 = 2 (-5.9 floors to -5)
])(
	"numberBitwiseAND floors operands before operation: $x & $y = $expected",
	({ x, y, expected }) => {
		const xValue = EngineValue.number(x);
		const yValue = EngineValue.number(y);
		const result = xValue.numberBitwiseAND(yValue);
		expect(result.data.value).toBe(expected);
	},
);

test.for([
	{ x: 2147483647, y: 1, expected: 1 }, // 0x7FFFFFFF & 1 = 1
	{ x: 2147483647, y: 2, expected: 2 }, // 0x7FFFFFFF & 2 = 2
	{ x: -2147483648, y: 1, expected: 0 }, // 0x80000000 & 1 = 0
	{ x: -2147483648, y: 2, expected: 0 }, // 0x80000000 & 2 = 0
	{ x: 1073741824, y: 1, expected: 0 }, // 0x40000000 & 1 = 0
	{ x: 1073741824, y: 2, expected: 0 }, // 0x40000000 & 2 = 0
])(
	"numberBitwiseAND handles 32-bit overflow edge cases: $x & $y = $expected",
	({ x, y, expected }) => {
		const xValue = EngineValue.number(x);
		const yValue = EngineValue.number(y);
		const result = xValue.numberBitwiseAND(yValue);
		expect(result.data.value).toBe(expected);
	},
);

// === NUMBER TO STRING CONVERSION ===

test.for([
	{ input: 42, expected: "42" },
	{ input: 0, expected: "0" },
	{ input: -42, expected: "-42" },
	{ input: 3.14, expected: "3.14" },
	{ input: -0.5, expected: "-0.5" },
	{ input: 0.0, expected: "0" },
])(
	"numberToString converts integers and floats to decimal strings: $input -> '$expected'",
	({ input, expected }) => {
		const number = EngineValue.number(input);
		const result = number.numberToString(10);
		expect(result.data.value).toBe(expected);
	},
);

test.for([
	{ input: NaN, expected: "NaN" },
	{ input: Infinity, expected: "Infinity" },
	{ input: -Infinity, expected: "-Infinity" },
])(
	"numberToString handles special values: $input -> '$expected'",
	({ input, expected }) => {
		const number = EngineValue.number(input);
		const result = number.numberToString(10);
		expect(result.data.value).toBe(expected);
	},
);

test("numberToString uses decimal (radix 10) by default", () => {
	const number = EngineValue.number(42);
	const result = number.numberToString(10);
	expect(result.data.value).toBe("42");
});

test.for([
	{ input: 42, radix: 1, expected: "" }, // Radix too small
	{ input: 42, radix: 37, expected: "" }, // Radix too large
	{ input: 42, radix: 0, expected: "" }, // Radix too small
])(
	"numberToString throws on invalid radices: $input -> radix $radix",
	({ input, radix }) => {
		const number = EngineValue.number(input);
		expect(() => number.numberToString(radix)).toThrow();
	},
);

test.for([
	{ input: Number.MAX_SAFE_INTEGER, expected: "9007199254740991" },
	{ input: Number.MIN_SAFE_INTEGER, expected: "-9007199254740991" },
	{ input: Number.MAX_VALUE, expected: "1.7976931348623157e+308" },
	{ input: Number.MIN_VALUE, expected: "5e-324" },
])(
	"numberToString handles boundary values: $input -> '$expected'",
	({ input, expected }) => {
		const number = EngineValue.number(input);
		const result = number.numberToString(10);
		expect(result.data.value).toBe(expected);
	},
);

test.for([
	{ input: 5, radix: 2, expected: "101" },
	{ input: 10, radix: 2, expected: "1010" },
	{ input: 15, radix: 2, expected: "1111" },
	{ input: 255, radix: 2, expected: "11111111" },
	{ input: 8, radix: 8, expected: "10" },
	{ input: 15, radix: 8, expected: "17" },
	{ input: 64, radix: 8, expected: "100" },
	{ input: 255, radix: 8, expected: "377" },
])(
	"numberToString converts to binary and octal: $input -> radix $radix = '$expected'",
	({ input, radix, expected }) => {
		const number = EngineValue.number(input);
		const result = number.numberToString(radix);
		expect(result.data.value).toBe(expected);
	},
);

test.for([
	{ input: 10, radix: 16, expected: "a" },
	{ input: 15, radix: 16, expected: "f" },
	{ input: 255, radix: 16, expected: "ff" },
	{ input: 4095, radix: 16, expected: "fff" },
	{ input: 65535, radix: 16, expected: "ffff" },
	{ input: 35, radix: 36, expected: "z" },
	{ input: 1295, radix: 36, expected: "zz" },
	{ input: 46655, radix: 36, expected: "zzz" },
])(
	"numberToString converts to hexadecimal and base-36: $input -> radix $radix = '$expected'",
	({ input, radix, expected }) => {
		const number = EngineValue.number(input);
		const result = number.numberToString(radix);
		expect(result.data.value).toBe(expected);
	},
);

test.for([
	{ input: -10, radix: 2, expected: "-1010" },
	{ input: -255, radix: 16, expected: "-ff" },
	{ input: -35, radix: 36, expected: "-z" },
])(
	"numberToString handles negative numbers with different radices: $input -> radix $radix = '$expected'",
	({ input, radix, expected }) => {
		const number = EngineValue.number(input);
		const result = number.numberToString(radix);
		expect(result.data.value).toBe(expected);
	},
);

test("numberToString uses decimal (radix 10) by default", () => {
	const number = EngineValue.number(42);
	const result = number.numberToString(10);
	expect(result.data.value).toBe("42");
});

test.for([
	{ input: 42, radix: 2, expected: "101010" }, // Large binary numbers
	{ input: 1000000, radix: 16, expected: "f4240" }, // Large hexadecimal numbers
	{ input: Number.MAX_SAFE_INTEGER, radix: 36, expected: "2gosa7pa2gv" }, // Very large base-36
])(
	"numberToString handles large numbers with different radices: $input -> radix $radix = '$expected'",
	({ input, radix, expected }) => {
		const number = EngineValue.number(input);
		const result = number.numberToString(radix);
		expect(result.data.value).toBe(expected);
	},
);
