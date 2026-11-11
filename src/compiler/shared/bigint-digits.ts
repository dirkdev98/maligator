export const BIGINT_MAX_BITS = 1 << 30;

/** Canonical least-significant-first base-2^32 magnitude of the wire format. */
export function bigintDigits(value: bigint): Array<number> {
	if (value === 0n) return [];
	const hex = (value < 0n ? -value : value).toString(16);
	if (hex.length > BIGINT_MAX_BITS / 4)
		throw new RangeError("Maximum BigInt size exceeded");
	const digits: Array<number> = [];
	for (let end = hex.length; end > 0; end -= 8)
		digits.push(parseInt(hex.slice(Math.max(0, end - 8), end), 16));
	return digits;
}

/** Least-significant-first base-2^64 magnitude in the native runtime's limb layout. */
export function bigintLimbs(value: bigint): Array<bigint> {
	const digits = bigintDigits(value);
	const limbs: Array<bigint> = [];
	for (let index = 0; index < digits.length; index += 2)
		limbs.push(BigInt(digits[index]!) | (BigInt(digits[index + 1] ?? 0) << 32n));
	return limbs;
}
