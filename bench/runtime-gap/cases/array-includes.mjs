import { runRuntimeGapCase } from "../case-runner.mjs";

const MODULUS = 1_000_000_007;

function normalized(value) {
	const result = value % MODULUS;
	return result < 0 ? result + MODULUS : result;
}

function result(checksum, operations) {
	return { checksum: normalized(checksum), operations };
}

function arrayIncludes(scale) {
	const values = Array.from({ length: 2_048 }, (_, index) => index * 3);
	let checksum = 0;
	const operations = 200_000 * scale;
	for (let index = 0; index < operations; index++) {
		checksum += values.includes((index & 2_047) * 3) ? 1 : 0;
	}
	return result(checksum, operations);
}

runRuntimeGapCase("array-includes", arrayIncludes);
