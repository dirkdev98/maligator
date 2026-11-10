export const NATIVE_STRING_SWITCH_CASE_LIMIT = 256;
export const NATIVE_STRING_SWITCH_CODE_UNIT_LIMIT = 8192;

// Match the runtime's encoding-independent hash, including its short-string branch.
export function nativeStringSwitchHash(codeUnits: ReadonlyArray<number>): number {
	if (codeUnits.length >= 64) {
		const lowBase = 0x10000000;
		const highBase = 0x20000000;
		let low = 0x4222846;
		let high = 0x1f29ce48;
		// Split the 57-bit state into 28/29-bit limbs. Multiplication by 2^40 + 435
		// and folding 2^57 to 13 keep every intermediate exact without BigInt allocation.
		for (const unit of codeUnits) {
			let bottom = low * 435 + unit + 1;
			const carry = Math.floor(bottom / lowBase);
			const lowUpper = Math.floor(low / 65536);
			const middle = high * 435 + carry + (low - lowUpper * 65536) * 4096;
			const middleCarry = Math.floor(middle / lowBase);
			const top = middleCarry + lowUpper + high * 4096;
			const topHalf = Math.floor(top / 2);
			bottom = bottom - carry * lowBase + topHalf * 13;
			const foldedCarry = Math.floor(bottom / lowBase);
			high = middle - middleCarry * lowBase + (top - topHalf * 2) * lowBase + foldedCarry;
			low = bottom - foldedCarry * lowBase;
			if (high >= highBase) {
				high -= highBase;
				low += 13;
				if (low >= lowBase) {
					low -= lowBase;
					high++;
				}
			}
			if (high === highBase - 1 && low >= lowBase - 13) {
				high = 0;
				low -= lowBase - 13;
			}
		}
		return (low + (high & 15) * lowBase) >>> 0;
	}
	let hash = 0x84222325;
	for (const unit of codeUnits) {
		hash = Math.imul(hash ^ (unit & 255), 0x1b3);
		hash = Math.imul(hash ^ (unit >>> 8), 0x1b3);
	}
	return hash >>> 0;
}
