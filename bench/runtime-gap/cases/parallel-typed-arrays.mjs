import { runRuntimeGapCase } from "../case-runner.mjs";

const MODULUS = 1_000_000_007;

function normalized(value) {
	const result = value % MODULUS;
	return result < 0 ? result + MODULUS : result;
}

function result(checksum, operations) {
	return { checksum: normalized(checksum), operations };
}

function parallelTypedArrays(scale) {
	const left = new Uint32Array(8_192);
	const right = new Uint32Array(8_192);
	const kinds = new Uint8Array(8_192);
	for (let index = 0; index < left.length; index++) {
		left[index] = index & 1_023;
		right[index] = (index * 17) & 1_023;
		kinds[index] = index & 31;
	}
	let checksum = 0;
	const rounds = 100 * scale;
	for (let round = 0; round < rounds; round++) {
		for (let index = 0; index < left.length; index++) {
			checksum += left[index] + right[index] + kinds[index];
		}
	}
	return result(checksum, left.length * rounds);
}

runRuntimeGapCase("parallel-typed-arrays", parallelTypedArrays);
