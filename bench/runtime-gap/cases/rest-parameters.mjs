import { runRuntimeGapCase } from "../case-runner.mjs";

const MODULUS = 1_000_000_007;

function normalized(value) {
	const result = value % MODULUS;
	return result < 0 ? result + MODULUS : result;
}

function result(checksum, operations) {
	return { checksum: normalized(checksum), operations };
}

function sumRest(...values) {
	return values[0] + values[1] + values[2] + values[3];
}

function restParameters(scale) {
	let checksum = 0;
	const operations = 500_000 * scale;
	for (let index = 0; index < operations; index++) {
		checksum += sumRest(index & 31, 3, 5, 7);
	}
	return result(checksum, operations);
}

runRuntimeGapCase("rest-parameters", restParameters);
