import { runRuntimeGapCase } from "../case-runner.mjs";

const MODULUS = 1_000_000_007;

function normalized(value) {
	const result = value % MODULUS;
	return result < 0 ? result + MODULUS : result;
}

function result(checksum, operations) {
	return { checksum: normalized(checksum), operations };
}

function numericScalarLoops(scale) {
	const iterations = 500_000 * scale;
	let checksum = 17;
	for (let index = 0; index < iterations; index++) {
		checksum = (checksum + ((index * 31) ^ (checksum >>> 3))) % MODULUS;
	}
	return result(checksum, iterations);
}

runRuntimeGapCase("numeric-scalar-loops", numericScalarLoops);
