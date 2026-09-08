import { describe, expect, it } from "vitest";
import { PORTABLE_CONSTANT_TARGET } from "../src/compiler/shared/constant-evaluator.ts";
import { evaluateConstantNumberSum } from "../src/compiler/shared/constant-number-sum.ts";

function integerOracle(values: ReadonlyArray<number>): number {
	if (values.some(Number.isNaN)) return NaN;
	if (values.includes(Infinity) && values.includes(-Infinity)) return NaN;
	if (values.includes(Infinity)) return Infinity;
	if (values.includes(-Infinity)) return -Infinity;
	const view = new DataView(new ArrayBuffer(8)),
		fractionMask = (1n << 52n) - 1n;
	let total = 0n;
	for (const value of values) {
		view.setFloat64(0, value, true);
		const bits = view.getBigUint64(0, true),
			exponent = Number((bits >> 52n) & 2047n);
		const significand = (bits & fractionMask) + (exponent === 0 ? 0n : 1n << 52n);
		const units = significand << BigInt(exponent === 0 ? 0 : exponent - 1);
		total += bits >> 63n === 0n ? units : -units;
	}
	if (total === 0n) return values.every((value) => Object.is(value, -0)) ? -0 : 0;
	const negative = total < 0n;
	if (negative) total = -total;
	const shift = Math.max(0, total.toString(2).length - 53),
		unit = 1n << BigInt(shift);
	let rounded = total / unit;
	const remainder = total % unit;
	if (remainder * 2n > unit || (remainder * 2n === unit && (rounded & 1n) !== 0n))
		rounded++;
	const magnitude = Number(rounded) * 2 ** (shift - 1074);
	return negative ? -magnitude : magnitude;
}

describe("bounded exact Number summation", () => {
	it("matches an independent integer accumulator across cancellation, ties and overflow", () => {
		const cases: Array<Array<number>> = [
			[],
			[-0],
			[-0, -0],
			[-0, 0],
			[1e20, 1, -1e20],
			[Number.MAX_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE],
			[Number.MAX_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE, -Number.MAX_VALUE],
			[1, 2 ** -53],
			[1, 2 ** -53, Number.MIN_VALUE],
			[1, 2 ** -53, -Number.MIN_VALUE],
			[Number.MAX_VALUE, 2 ** 970],
			[Number.MAX_VALUE, 2 ** 970, -Number.MIN_VALUE],
			[Number.MIN_VALUE, Number.MIN_VALUE],
			[Infinity, -Infinity],
			[NaN, Infinity],
		];
		const bits = new DataView(new ArrayBuffer(8));
		let seed = 0x71329;
		const word = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
		for (let index = 0; index < 128; index++) {
			const values: Array<number> = [];
			for (let item = 0; item < 1 + (index % 64); item++) {
				bits.setUint32(0, word(), true);
				bits.setUint32(4, word(), true);
				values.push(bits.getFloat64(0, true));
			}
			cases.push(values);
		}
		for (const values of cases) {
			const result = evaluateConstantNumberSum(values);
			expect(result.kind).toBe("value");
			if (result.kind !== "value" || result.value.kind !== "number")
				throw new Error("Expected sum");
			expect(Object.is(result.value.value, integerOracle(values)), String(values)).toBe(
				true,
			);
		}
	});
	it("honors the target contract and bounded evaluation budget", () => {
		expect(evaluateConstantNumberSum(new Array(65).fill(1))).toMatchObject({
			kind: "unsupported",
			reason: "work-limit",
		});
		expect(evaluateConstantNumberSum([1, 2], PORTABLE_CONSTANT_TARGET, 1)).toMatchObject({
			kind: "unsupported",
			reason: "work-limit",
		});
		expect(
			evaluateConstantNumberSum([1], {
				...PORTABLE_CONSTANT_TARGET,
				numbers: "uncertified",
			}),
		).toMatchObject({ kind: "unsupported", reason: "target-contract" });
	});
});
