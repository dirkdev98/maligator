import { runRuntimeGapCase } from "../case-runner.mjs";

const MODULUS = 1_000_000_007;

function normalized(value) {
	const result = value % MODULUS;
	return result < 0 ? result + MODULUS : result;
}

function result(checksum, operations) {
	return { checksum: normalized(checksum), operations };
}

function indirectCalls(scale) {
	const functions = [
		(value) => value + 1,
		(value) => value * 3,
		(value) => value ^ 0x55,
		(value) => value - 7,
	];
	let checksum = 0;
	const operations = 900_000 * scale;
	for (let index = 0; index < operations; index++) {
		checksum = (checksum + functions[index & 3](index & 1_023)) % MODULUS;
	}
	return result(checksum, operations);
}

runRuntimeGapCase("indirect-calls", indirectCalls);
