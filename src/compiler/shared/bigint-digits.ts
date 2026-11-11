export const BIGINT_MAX_BITS = 1 << 30;

/** Canonical least-significant-first base-2^32 magnitude, shared by native and wire constants. */
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
