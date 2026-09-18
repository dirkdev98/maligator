import { runRuntimeGapCase } from "../case-runner.mjs";

const MODULUS = 1_000_000_007;

function normalized(value) {
	const result = value % MODULUS;
	return result < 0 ? result + MODULUS : result;
}

function result(checksum, operations) {
	return { checksum: normalized(checksum), operations };
}

function typedArrayOperations(scale) {
	const values = new Uint32Array(4_096);
	let checksum = 0;
	for (let round = 0; round < 80 * scale; round++) {
		for (let index = 0; index < values.length; index++) {
			values[index] = (index * 31 + round * 17) >>> 0;
		}
		for (let index = 0; index < values.length; index++) {
			values[index] = (values[index] + values[(index + 1) & 4_095]) >>> 0;
			checksum = (checksum + values[index]) % MODULUS;
		}
	}
	return result(checksum, values.length * 160 * scale);
}

runRuntimeGapCase("typed-array-operations", typedArrayOperations);
