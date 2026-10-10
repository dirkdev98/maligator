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
	compilerNumericResultKind,
	compilerOperatorInputKindsHaveExactNativeSemantics as exactNativeKinds,
} from "../src/compiler/shared/compiler-value-kinds.ts";

const singleKinds = (mask: number): ReadonlyArray<number> =>
	Array.from({ length: 8 }, (_, bit) => 1 << bit).filter((kind) => mask & kind);

// ToPrimitive on an object can return any primitive through user code.
const primitives = (kind: number): ReadonlyArray<number> =>
	kind === OBJECT ? singleKinds(TOP & ~OBJECT) : [kind];

// ToNumeric of one primitive kind; undefined means it throws.
const toNumeric = (kind: number): number | undefined =>
	kind === SYMBOL ? undefined : kind === BIGINT ? BIGINT : NUMBER;

function specResultKinds(operation: "unary" | "binary" | "add", left: number, right = 0) {
	let result = 0;
	for (const leftKind of singleKinds(left))
		for (const leftPrimitive of primitives(leftKind)) {
			if (operation === "unary") {
				result |= toNumeric(leftPrimitive) ?? 0;
				continue;
			}
			for (const rightKind of singleKinds(right))
				for (const rightPrimitive of primitives(rightKind)) {
					if (
						operation === "add" &&
						(leftPrimitive === STRING || rightPrimitive === STRING)
					) {
						if (leftPrimitive !== SYMBOL && rightPrimitive !== SYMBOL) result |= STRING;
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
	it("preserves the numeric and equality domains across every eight-bit mask", () => {
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
		for (let mask = 0; mask <= 256; mask++) {
			const numeric = mask > 0 && (mask & ~15) === 0;
			const comparable = mask > 0 && ((mask & ~9) === 0 || (mask & ~3) === 0);
			for (const operator of unary) {
				equal(exactNativeKinds("unary", operator, [mask]), numeric);
			}
			equal(exactNativeKinds("unary", "tostring", [mask]), mask === 4);
			for (const operator of arithmetic) {
				equal(exactNativeKinds("binary", operator, [8, mask]), numeric);
				equal(exactNativeKinds("binary", operator, [mask, 8]), numeric);
			}
			for (const operator of equality) {
				equal(exactNativeKinds("binary", operator, [9, mask]), comparable);
			}
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
			for (let mask = 1; mask <= 255; mask++) {
				for (const nullish of [1, 2, 3]) {
					equal(exactNativeKinds("binary", operator, [mask, nullish]), true);
					equal(exactNativeKinds("binary", operator, [nullish, mask]), true);
				}
			}
			equal(exactNativeKinds("binary", operator, [255, 255]), false);
			equal(exactNativeKinds("binary", operator, [255, 8]), false);
			equal(exactNativeKinds("binary", operator, [0, 2]), false);
		}
		for (const operator of ["<", "+", "in"]) {
			equal(exactNativeKinds("binary", operator, [255, 2]), false);
		}
	});

	it("rejects unsupported operators, wrong arities and invalid masks", () => {
		for (const operator of ["in", "instanceof", "&&", "||", "??", "constructor"]) {
			equal(exactNativeKinds("binary", operator, [8, 8]), false);
		}
		for (const mask of [-1, NaN, Infinity, 0.5, 255]) {
			equal(exactNativeKinds("unary", "+", [mask]), false);
		}
		equal(exactNativeKinds("other", "+", [8]), false);
		equal(exactNativeKinds("unary", "+", [8, 8]), false);
		equal(exactNativeKinds("binary", "+", [8]), false);
		equal(exactNativeKinds("unary", undefined, [8]), false);
	});

	it("preserves builtin mask membership and argument-count limits", () => {
		for (let mask = 0; mask <= 256; mask++) {
			equal(compilerBuiltinInputKindsAreValid([mask], 1), [4, 8, 16, 255].includes(mask));
		}
		equal(compilerBuiltinInputKindsAreValid([4, 8, 16, 255], 4), true);
		equal(compilerBuiltinInputKindsAreValid(new Array<number>(17).fill(8), 17), true);
		equal(compilerBuiltinInputKindsAreValid(new Array<number>(18).fill(8), 18), false);
		equal(compilerBuiltinInputKindsAreValid([], 0), false);
		equal(compilerBuiltinInputKindsAreValid([8], 2), false);
	});
});
