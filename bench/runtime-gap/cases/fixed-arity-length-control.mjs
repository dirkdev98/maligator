import { runRuntimeGapCase } from "../case-runner.mjs";

const MODULUS = 1_000_000_007;

function normalized(value) {
	const result = value % MODULUS;
	return result < 0 ? result + MODULUS : result;
}

function result(checksum, operations) {
	return { checksum: normalized(checksum), operations };
}

function fixedArityLength(_first, _second, _third, _fourth) {
	return 4;
}

function fixedArityLengthControl(scale) {
	let checksum = 0;
	const operations = 500_000 * scale;
	for (let index = 0; index < operations; index++) {
		checksum += fixedArityLength(index & 31, 3, 5, 7);
	}
	return result(checksum, operations);
}

runRuntimeGapCase("fixed-arity-length-control", fixedArityLengthControl);
