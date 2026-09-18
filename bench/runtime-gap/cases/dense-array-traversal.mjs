import { runRuntimeGapCase } from "../case-runner.mjs";

const MODULUS = 1_000_000_007;

function normalized(value) {
	const result = value % MODULUS;
	return result < 0 ? result + MODULUS : result;
}

function result(checksum, operations) {
	return { checksum: normalized(checksum), operations };
}

function denseArrayTraversal(scale) {
	const values = Array.from({ length: 16_384 }, (_, index) => index & 255);
	let checksum = 0;
	const rounds = 120 * scale;
	for (let round = 0; round < rounds; round++) {
		for (let index = 0; index < values.length; index++) checksum += values[index];
	}
	return result(checksum, values.length * rounds);
}

runRuntimeGapCase("dense-array-traversal", denseArrayTraversal);
