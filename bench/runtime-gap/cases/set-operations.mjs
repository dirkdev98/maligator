import { runRuntimeGapCase } from "../case-runner.mjs";

const MODULUS = 1_000_000_007;

function normalized(value) {
	const result = value % MODULUS;
	return result < 0 ? result + MODULUS : result;
}

function result(checksum, operations) {
	return { checksum: normalized(checksum), operations };
}

function setOperations(scale) {
	let checksum = 0;
	let operations = 0;
	for (let round = 0; round < 100 * scale; round++) {
		const values = new Set();
		for (let index = 0; index < 2_048; index++) {
			values.add((index * 17 + round) & 4_095);
			operations++;
		}
		for (let index = 0; index < 2_048; index++) {
			checksum += values.has(index) ? index : 0;
			operations++;
		}
		for (const value of values) {
			checksum = (checksum + value) % MODULUS;
			operations++;
		}
	}
	return result(checksum, operations);
}

runRuntimeGapCase("set-operations", setOperations);
