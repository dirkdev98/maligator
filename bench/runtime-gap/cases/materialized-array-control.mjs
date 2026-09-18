import { runRuntimeGapCase } from "../case-runner.mjs";

const MODULUS = 1_000_000_007;

function normalized(value) {
	const result = value % MODULUS;
	return result < 0 ? result + MODULUS : result;
}

function result(checksum, operations) {
	return { checksum: normalized(checksum), operations };
}

function collectFour(first, second, third, fourth) {
	return [first, second, third, fourth];
}

function materializedArrayControl(scale) {
	const retained = new Array(32);
	const operations = 200_000 * scale;
	for (let index = 0; index < operations; index++) {
		retained[index & 31] = collectFour(index & 31, 3, 5, 7);
	}
	let checksum = 0;
	for (const values of retained) {
		checksum += values[0] + values[1] + values[2] + values[3];
	}
	return result(checksum, operations);
}

runRuntimeGapCase("materialized-array-control", materializedArrayControl);
