import { equal } from "node:assert";
import { describe, it } from "vitest";
import {
	compilerBuiltinInputKindsAreValid,
	compilerOperatorInputKindsHaveExactNativeSemantics as exactNativeKinds,
} from "../src/compiler/shared/compiler-value-kinds.ts";

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
