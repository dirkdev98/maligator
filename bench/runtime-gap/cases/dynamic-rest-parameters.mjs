import { runRuntimeGapCase } from "../case-runner.mjs";

const MODULUS = 1_000_000_007;

function normalized(value) {
	const result = value % MODULUS;
	return result < 0 ? result + MODULUS : result;
}

function result(checksum, operations) {
	return { checksum: normalized(checksum), operations };
}

function sumRestDynamic(selector, ...values) {
	const start = selector & 3;
	return (
		values[start] +
		values[(start + 1) & 3] +
		values[(start + 2) & 3] +
		values[(start + 3) & 3]
	);
}

function dynamicRestParameters(scale) {
	let checksum = 0;
	const operations = 500_000 * scale;
	for (let index = 0; index < operations; index++) {
		checksum += sumRestDynamic(index, index & 31, 3, 5, 7);
	}
	return result(checksum, operations);
}

runRuntimeGapCase("dynamic-rest-parameters", dynamicRestParameters);
