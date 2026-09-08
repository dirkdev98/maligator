import {
	evaluateConstantOperation,
	PORTABLE_CONSTANT_TARGET,
} from "./constant-evaluator.ts";
import type {
	ConstantEvaluation,
	ConstantEvaluationTarget,
} from "./constant-evaluator.ts";

export function evaluateConstantNumberSum(
	values: ReadonlyArray<number>,
	target: ConstantEvaluationTarget = PORTABLE_CONSTANT_TARGET,
	workLimit = 4096,
): ConstantEvaluation {
	const contract = evaluateConstantOperation(
		"number.unary:+",
		[{ kind: "number", value: 0 }],
		target,
		workLimit,
	);
	if (contract.kind !== "value") return contract;
	let work = 1;
	const result = (value: number): ConstantEvaluation => ({
		kind: "value",
		value: { kind: "number", value },
		work,
	});
	const limited = (): ConstantEvaluation => ({
		kind: "unsupported",
		reason: "work-limit",
		work,
	});
	if (values.length > 64) return limited();
	let positiveInfinity = false,
		negativeInfinity = false,
		allNegativeZero = true;
	for (const value of values) {
		if (++work > workLimit) return limited();
		if (Number.isNaN(value)) return result(NaN);
		positiveInfinity ||= value === Infinity;
		negativeInfinity ||= value === -Infinity;
		allNegativeZero &&= Object.is(value, -0);
	}
	if (positiveInfinity || negativeInfinity)
		return result(
			positiveInfinity && negativeInfinity
				? NaN
				: positiveInfinity
					? Infinity
					: -Infinity,
		);
	if (allNegativeZero) return result(-0);
	// Base 2^24 leaves every shifted limb addition exact within binary64's 53 bits.
	const base = 16777216,
		limbCount = 90;
	work += limbCount * 2;
	if (work > workLimit) return limited();
	const positive = new Array<number>(limbCount).fill(0),
		negative = new Array<number>(limbCount).fill(0);
	const bits = new DataView(new ArrayBuffer(8));
	for (const value of values) {
		if (value === 0) continue;
		bits.setFloat64(0, value, true);
		const low = bits.getUint32(0, true),
			high = bits.getUint32(4, true),
			exponent = (high >>> 20) & 0x7ff;
		let significand =
			(high & 0xfffff) * 4294967296 + low + (exponent === 0 ? 0 : 4503599627370496);
		const shift = exponent === 0 ? 0 : exponent - 1;
		let index = Math.floor(shift / 24);
		const factor = 1 << (shift % 24),
			accumulator = value < 0 ? negative : positive;
		while (significand !== 0) {
			let carry = (significand % base) * factor;
			significand = Math.floor(significand / base);
			for (let at = index; carry !== 0; at++) {
				if (++work > workLimit) return limited();
				const total = accumulator[at]! + carry;
				accumulator[at] = total % base;
				carry = Math.floor(total / base);
			}
			index++;
		}
	}
	let top = limbCount - 1;
	while (top >= 0 && positive[top] === negative[top]) {
		if (++work > workLimit) return limited();
		top--;
	}
	if (top < 0) return result(0);
	const negativeResult = negative[top]! > positive[top]!;
	const magnitude = negativeResult ? negative : positive,
		subtrahend = negativeResult ? positive : negative;
	let borrow = 0;
	for (let index = 0; index <= top; index++) {
		if (++work > workLimit) return limited();
		const difference = magnitude[index]! - subtrahend[index]! - borrow;
		borrow = difference < 0 ? 1 : 0;
		magnitude[index] = difference < 0 ? difference + base : difference;
	}
	while (magnitude[top] === 0) top--;
	let highestBit = top * 24 + 31 - Math.clz32(magnitude[top]!);
	const bit = (index: number) =>
		((magnitude[Math.floor(index / 24)] ?? 0) >>> (index % 24)) & 1;
	const discarded = Math.max(0, highestBit - 52);
	let significand = 0;
	for (let index = highestBit; index >= discarded; index--) {
		if (++work > workLimit) return limited();
		significand = significand * 2 + bit(index);
	}
	if (discarded > 0 && bit(discarded - 1) !== 0) {
		let sticky = false;
		for (let index = 0; index < discarded - 1; index += 24) {
			if (++work > workLimit) return limited();
			const width = Math.min(24, discarded - 1 - index);
			if ((magnitude[index / 24]! & ((1 << width) - 1)) !== 0) {
				sticky = true;
				break;
			}
		}
		if (sticky || significand % 2 !== 0) significand++;
	}
	if (significand === 9007199254740992) {
		significand /= 2;
		highestBit++;
	}
	if (highestBit >= 2098) return result(negativeResult ? -Infinity : Infinity);
	const exponent = highestBit < 52 ? 0 : highestBit - 51;
	if (exponent !== 0) significand -= 4503599627370496;
	bits.setUint32(0, significand % 4294967296, true);
	bits.setUint32(
		4,
		(negativeResult ? 0x80000000 : 0) +
			exponent * 1048576 +
			Math.floor(significand / 4294967296),
		true,
	);
	return result(bits.getFloat64(0, true));
}
