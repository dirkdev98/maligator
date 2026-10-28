import { equal } from "node:assert";
import { describe, expect, it } from "vitest";
import {
	COMPILER_VALUE_KIND_BIGINT as BIGINT,
	COMPILER_VALUE_KIND_NUMBER as NUMBER,
	COMPILER_VALUE_KIND_OBJECT as OBJECT,
	COMPILER_VALUE_KIND_STRING as STRING,
	COMPILER_VALUE_KIND_SYMBOL as SYMBOL,
	COMPILER_VALUE_KIND_TOP as TOP,
	compilerBuiltinInputKindsAreValid,
	compilerPrimitiveConversionOperator,
	compilerNumericResultKind,
	compilerOperatorInputKindsHaveExactNativeSemantics as exactNativeKinds,
	compilerTypeofComparison,
	compilerValueKindTruthiness,
	compilerValueKindCanBeHeldWeakly,
	compilerValueKindCannotBeHeldWeakly,
} from "../src/compiler/shared/compiler-value-kinds.ts";

const singleKinds = (mask: number): ReadonlyArray<number> =>
	Array.from({ length: Math.floor(Math.log2(TOP)) + 1 }, (_, bit) => 1 << bit).filter(
		(kind) => mask & kind,
	);

// ToPrimitive on an object can return any primitive through user code.
const primitives = (kind: number): ReadonlyArray<number> =>
	kind === OBJECT ? singleKinds(TOP & ~OBJECT) : [kind];

// ToNumeric of one primitive kind; undefined means it throws.
const toNumeric = (kind: number): number | undefined =>
	(kind & SYMBOL) !== 0 ? undefined : kind === BIGINT ? BIGINT : NUMBER;

const primitiveAlternatives = Array.from({ length: TOP + 1 }, (_, mask) => [
	...new Set(singleKinds(mask).flatMap(primitives)),
]);

function specResultKinds(operation: "unary" | "binary" | "add", left: number, right = 0) {
	let result = 0;
	for (const leftPrimitive of primitiveAlternatives[left]!) {
		if (operation === "unary") {
			result |= toNumeric(leftPrimitive) ?? 0;
			continue;
		}
		for (const rightPrimitive of primitiveAlternatives[right]!) {
			if (
				operation === "add" &&
				(leftPrimitive === STRING || rightPrimitive === STRING)
			) {
				if (((leftPrimitive | rightPrimitive) & SYMBOL) === 0) result |= STRING;
				continue;
			}
			const leftNumeric = toNumeric(leftPrimitive);
			if (leftNumeric !== undefined && leftNumeric === toNumeric(rightPrimitive))
				result |= leftNumeric;
		}
	}
	return result;
}

describe("Compiler value-kind operator dispatch", () => {
	it("preserves the numeric and equality domains across every kind mask", () => {
		const unary = ["-", "+", "~", "increment", "decrement", "tonumeric"];
		const arithmetic = [
			"+",
			"-",
			"*",
			"/",
			"%",
			"**",
			"&",
			"|",
			"^",
			"<<",
			">>",
			">>>",
			"<",
			"<=",
			">",
			">=",
		];
		const equality = ["==", "!=", "===", "!=="];
		for (let mask = 0; mask <= TOP + 1; mask++) {
			const numeric = mask > 0 && (mask & ~15) === 0;
			const toNumber = mask > 0 && (mask & ~31) === 0;
			const comparable = mask > 0 && ((mask & ~9) === 0 || (mask & ~3) === 0);
			for (const operator of unary) {
				equal(exactNativeKinds("unary", operator, [mask]), toNumber);
			}
			equal(
				exactNativeKinds("unary", "tostring", [mask]),
				mask > 0 && (mask & ~63) === 0,
			);
			for (const operator of arithmetic) {
				// Number + String concatenates without coercing either operand.
				const concatenation = operator === "+" && mask === 16;
				equal(exactNativeKinds("binary", operator, [8, mask]), numeric || concatenation);
				equal(exactNativeKinds("binary", operator, [mask, 8]), numeric || concatenation);
			}
			const stringConvertible = mask > 0 && (mask & ~63) === 0;
			equal(exactNativeKinds("binary", "+", [16, mask]), stringConvertible);
			equal(exactNativeKinds("binary", "+", [mask, 16]), stringConvertible);
			equal(exactNativeKinds("binary", "-", [16, mask]), false);
			for (const operator of equality) {
				equal(exactNativeKinds("binary", operator, [9, mask]), comparable);
			}
		}
	});

	it("normalizes only builtin conversions with the same primitive and object semantics", () => {
		for (let mask = 1; mask <= TOP; mask++) {
			const kinds = singleKinds(mask);
			equal(
				compilerPrimitiveConversionOperator("Number", mask),
				kinds.every((kind) => kind !== BIGINT && kind !== OBJECT) ? "+" : undefined,
			);
			equal(
				compilerPrimitiveConversionOperator("String", mask),
				kinds.every((kind) => (kind & SYMBOL) === 0) ? "tostring" : undefined,
			);
		}
		for (const invalid of [0, TOP + 1, -1, NaN, 1.5]) {
			equal(compilerPrimitiveConversionOperator("Number", invalid), undefined);
			equal(compilerPrimitiveConversionOperator("String", invalid), undefined);
		}
	});

	it("transfers every normal numeric operator result the specification allows", () => {
		for (let left = 1; left <= TOP; left++) {
			const unary = compilerNumericResultKind("unary", left);
			equal(unary & specResultKinds("unary", left), specResultKinds("unary", left));
			for (let right = 1; right <= TOP; right++)
				for (const operation of ["binary", "add"] as const) {
					const spec = specResultKinds(operation, left, right);
					equal(compilerNumericResultKind(operation, left, right) & spec, spec);
				}
		}
	});

	it("excludes BigInt and String results that the operand kinds cannot produce", () => {
		expect(compilerNumericResultKind("add", NUMBER, TOP)).toBe(NUMBER | STRING);
		expect(compilerNumericResultKind("add", NUMBER | STRING, NUMBER)).toBe(
			NUMBER | STRING,
		);
		expect(compilerNumericResultKind("binary", NUMBER | STRING, TOP)).toBe(NUMBER);
		expect(compilerNumericResultKind("binary", TOP, TOP)).toBe(NUMBER | BIGINT);
		expect(compilerNumericResultKind("unary", STRING)).toBe(NUMBER);
		expect(compilerNumericResultKind("add", BIGINT, BIGINT)).toBe(BIGINT);
	});

	it("admits equality against a proven nullish operand whatever the other operand", () => {
		for (const operator of ["==", "!=", "===", "!=="]) {
			for (let mask = 1; mask <= TOP; mask++) {
				for (const nullish of [1, 2, 3]) {
					equal(exactNativeKinds("binary", operator, [mask, nullish]), true);
					equal(exactNativeKinds("binary", operator, [nullish, mask]), true);
				}
			}
			equal(exactNativeKinds("binary", operator, [TOP, TOP]), false);
			equal(exactNativeKinds("binary", operator, [TOP, 8]), false);
			equal(exactNativeKinds("binary", operator, [0, 2]), false);
		}
		for (const operator of ["<", "+", "in"]) {
			equal(exactNativeKinds("binary", operator, [TOP, 2]), false);
		}
	});

	it("rejects unsupported operators, wrong arities and invalid masks", () => {
		for (const operator of ["in", "instanceof", "&&", "||", "??", "constructor"]) {
			equal(exactNativeKinds("binary", operator, [8, 8]), false);
		}
		for (const mask of [-1, NaN, Infinity, 0.5, TOP]) {
			equal(exactNativeKinds("unary", "+", [mask]), false);
		}
		equal(exactNativeKinds("other", "+", [8]), false);
		equal(exactNativeKinds("unary", "+", [8, 8]), false);
		equal(exactNativeKinds("binary", "+", [8]), false);
		equal(exactNativeKinds("unary", undefined, [8]), false);
	});

	it("preserves every builtin kind union independently of kernel arity limits", () => {
		for (let mask = 0; mask <= TOP + 1; mask++) {
			equal(compilerBuiltinInputKindsAreValid([mask], 1), mask > 0 && mask <= TOP);
		}
		equal(compilerBuiltinInputKindsAreValid([4, 8, 16, TOP], 4), true);
		equal(compilerBuiltinInputKindsAreValid(new Array<number>(17).fill(8), 17), true);
		equal(compilerBuiltinInputKindsAreValid(new Array<number>(18).fill(8), 18), true);
		equal(compilerBuiltinInputKindsAreValid([], 0), false);
		equal(compilerBuiltinInputKindsAreValid([8], 2), false);
	});

	it("matches JavaScript typeof observations for every kind union", () => {
		const values: ReadonlyArray<ReadonlyArray<unknown>> = [
			[undefined],
			[null],
			[false, true],
			[0, -0, NaN, Infinity],
			["", "x"],
			[1n],
			[Symbol("x")],
			[{}, [], () => {}],
			[Symbol.for("x")],
		];
		const results = [
			"undefined",
			"object",
			"boolean",
			"number",
			"string",
			"bigint",
			"symbol",
			"function",
		] as const;
		for (let mask = 1; mask <= TOP; mask++) {
			for (const result of results) {
				const outcomes = new Set<boolean>();
				for (const [bit, representatives] of values.entries())
					if ((mask & (1 << bit)) !== 0)
						for (const value of representatives) outcomes.add(typeof value === result);
				equal(
					compilerTypeofComparison(mask, result),
					outcomes.size === 1 ? [...outcomes][0] : undefined,
				);
			}
		}
	});
});

it("matches weak key admission for every kind union", () => {
	const values: ReadonlyArray<ReadonlyArray<unknown>> = [
		[undefined],
		[null],
		[false, true],
		[0, NaN],
		["", "x"],
		[0n, 1n],
		[Symbol("local"), Symbol.iterator],
		[{}, [], () => {}, new Proxy({}, {})],
		[Symbol.for("registered")],
	];
	const outcomesByKind = values.map((representatives) =>
		representatives.map((value) => {
			try {
				new WeakSet().add(value as WeakKey);
				return true;
			} catch (error) {
				if (!(error instanceof TypeError)) throw error;
				return false;
			}
		}),
	);
	for (let mask = 1; mask <= TOP; mask++) {
		const outcomes = outcomesByKind.flatMap((outcomes, bit) =>
			(mask & (1 << bit)) !== 0 ? outcomes : [],
		);
		equal(compilerValueKindCanBeHeldWeakly(mask), outcomes.every(Boolean));
		equal(
			compilerValueKindCannotBeHeldWeakly(mask),
			outcomes.every((value) => !value),
		);
	}
	equal(compilerValueKindCanBeHeldWeakly(0), false);
	equal(compilerValueKindCannotBeHeldWeakly(0), false);
});

it("matches JavaScript Boolean observations for every kind union", () => {
	const values: ReadonlyArray<ReadonlyArray<unknown>> = [
		[undefined],
		[null],
		[false, true],
		[0, -0, NaN, Infinity],
		["", "x"],
		[0n, 1n],
		[Symbol("x")],
		[{}, [], () => {}],
		[Symbol.for("x")],
	];
	for (let mask = 1; mask <= TOP; mask++) {
		const outcomes = new Set<boolean>();
		for (const [bit, representatives] of values.entries())
			if ((mask & (1 << bit)) !== 0)
				for (const value of representatives) outcomes.add(Boolean(value));
		equal(
			compilerValueKindTruthiness(mask),
			outcomes.size === 1 ? [...outcomes][0] : undefined,
		);
	}
});
