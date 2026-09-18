import { runRuntimeGapCase } from "../case-runner.mjs";

const MODULUS = 1_000_000_007;

function normalized(value) {
	const result = value % MODULUS;
	return result < 0 ? result + MODULUS : result;
}

function result(checksum, operations) {
	return { checksum: normalized(checksum), operations };
}

function chooseRestBoundedFour(selector, ...values) {
	return values[+selector & 3];
}

function fourWayBoundedRestSelection(scale) {
	let checksum = 0;
	const operations = 500_000 * scale;
	for (let index = 0; index < operations; index++) {
		checksum += chooseRestBoundedFour(index, index & 31, 3, 5, 7);
	}
	return result(checksum, operations);
}

runRuntimeGapCase("four-way-bounded-rest-selection", fourWayBoundedRestSelection);
