import { runRuntimeGapCase } from "../case-runner.mjs";

const MODULUS = 1_000_000_007;

function normalized(value) {
	const result = value % MODULUS;
	return result < 0 ? result + MODULUS : result;
}

function result(checksum, operations) {
	return { checksum: normalized(checksum), operations };
}

function addThree(left, middle, right) {
	return left + middle + right;
}

function directCalls(scale) {
	let checksum = 0;
	const operations = 1_200_000 * scale;
	for (let index = 0; index < operations; index++) {
		checksum = (checksum + addThree(index & 255, index & 127, index & 63)) % MODULUS;
	}
	return result(checksum, operations);
}

runRuntimeGapCase("direct-calls", directCalls);
