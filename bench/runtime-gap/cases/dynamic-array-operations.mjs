import { runRuntimeGapCase } from "../case-runner.mjs";

const MODULUS = 1_000_000_007;

function normalized(value) {
	const result = value % MODULUS;
	return result < 0 ? result + MODULUS : result;
}

function result(checksum, operations) {
	return { checksum: normalized(checksum), operations };
}

function dynamicArrayOperations(scale) {
	let checksum = 0;
	let operations = 0;
	for (let round = 0; round < 250 * scale; round++) {
		const values = [];
		for (let index = 0; index < 1_024; index++) {
			values.push(index ^ round);
			operations++;
		}
		for (let index = 0; index < values.length; index++) {
			checksum = (checksum + values[index]) % MODULUS;
			operations++;
		}
		while (values.length > 512) {
			checksum ^= values.pop();
			operations++;
		}
	}
	return result(checksum, operations);
}

runRuntimeGapCase("dynamic-array-operations", dynamicArrayOperations);
