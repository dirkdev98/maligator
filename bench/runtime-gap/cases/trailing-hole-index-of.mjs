import { runRuntimeGapCase } from "../case-runner.mjs";

const MODULUS = 1_000_000_007;

function normalized(value) {
	const result = value % MODULUS;
	return result < 0 ? result + MODULUS : result;
}

function result(checksum, operations) {
	return { checksum: normalized(checksum), operations };
}

function trailingHoleIndexOf(scale) {
	const values = Array.from({ length: 1_024 }, (_, index) => index * 3 + 1);
	values.length = 16_384;
	let checksum = 0;
	const searches = 2_000 * scale;
	for (let index = 0; index < searches; index++) {
		const needle = index & 1 ? (896 + (index & 127)) * 3 + 1 : -((index & 1_023) + 1);
		checksum += values.indexOf(needle) + 1;
	}
	return result(checksum, searches);
}

runRuntimeGapCase("trailing-hole-index-of", trailingHoleIndexOf);
