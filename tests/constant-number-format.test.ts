import { describe, expect, it } from "vitest";
import {
	formatConstantNumber,
	formatConstantNumberRadix,
} from "../src/compiler/shared/constant-number-format.ts";

describe("exact constant Number formatting", () => {
	it("matches shortest and explicit precision output across binary64 exponents", () => {
		const values = [
			0,
			-0,
			1,
			0.1,
			1.005,
			2.55,
			1.25,
			1e-7,
			1e-6,
			1e21,
			Number.MIN_VALUE,
			Number.MAX_VALUE,
			2.2250738585072014e-308,
			1000000000000000128,
			NaN,
			Infinity,
			-Infinity,
		];
		const bits = new DataView(new ArrayBuffer(8));
		let seed = 1;
		for (let index = 0; index < 128; index++) {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
			bits.setUint32(0, seed);
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
			bits.setUint32(4, seed);
			values.push(bits.getFloat64(0));
		}
		for (const value of values) {
			expect(formatConstantNumber(value, "toString"), String(value)).toBe(
				value.toString(),
			);
			for (const method of ["toFixed", "toExponential", "toPrecision"] as const) {
				for (const digits of [undefined, method === "toPrecision" ? 1 : 0, 6, 17, 100])
					expect(
						formatConstantNumber(value, method, digits),
						`${value}.${method}(${digits})`,
					).toBe(value[method](digits));
			}
		}
	});

	it("keeps invalid precision residual", () => {
		expect(formatConstantNumber(1, "toFixed", 101)).toBeUndefined();
		expect(formatConstantNumber(1, "toPrecision", 0)).toBeUndefined();
		expect(formatConstantNumber(1, "toExponential", -1)).toBeUndefined();
	});
	it.each([
		[0.1, 3, "0.0022002200220022002200220022002201"],
		[Math.PI, 16, "3.243f6a8885a3"],
		[-0.1, 7, "-0.04620462046204620463"],
		[9007199254740992, 16, "20000000000000"],
		[1.0000000000000002, 2, "1.0000000000000000000000000000000000000000000000000001"],
	] as const)(
		"formats %s in base %s using the target's binary rounding interval",
		(value, radix, expected) => {
			expect(formatConstantNumberRadix(value, radix)).toBe(expected);
		},
	);
	it("retains the full binary exponent range without a significant-digit cutoff", () => {
		expect(formatConstantNumberRadix(Number.MIN_VALUE, 2)).toBe(`0.${"0".repeat(1073)}1`);
		expect(formatConstantNumberRadix(Number.MAX_VALUE, 2)).toBe(
			`${"1".repeat(53)}${"0".repeat(971)}`,
		);
		for (let radix = 2; radix <= 36; radix++) {
			expect(formatConstantNumberRadix(radix, radix)).toBe("10");
			expect(formatConstantNumberRadix(-radix, radix)).toBe("-10");
		}
	});
});
