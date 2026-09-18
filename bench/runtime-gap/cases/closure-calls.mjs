import { runRuntimeGapCase } from "../case-runner.mjs";

const MODULUS = 1_000_000_007;

function normalized(value) {
	const result = value % MODULUS;
	return result < 0 ? result + MODULUS : result;
}

function result(checksum, operations) {
	return { checksum: normalized(checksum), operations };
}

function closureCalls(scale) {
	const functions = Array.from(
		{ length: 64 },
		(_, offset) => (value) => value + offset * 7,
	);
	let checksum = 0;
	const operations = 900_000 * scale;
	for (let index = 0; index < operations; index++) {
		checksum = (checksum + functions[index & 63](index & 1_023)) % MODULUS;
	}
	return result(checksum, operations);
}

runRuntimeGapCase("closure-calls", closureCalls);
