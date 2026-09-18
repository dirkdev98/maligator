import { runRuntimeGapCase } from "../case-runner.mjs";

const MODULUS = 1_000_000_007;

function normalized(value) {
	const result = value % MODULUS;
	return result < 0 ? result + MODULUS : result;
}

function result(checksum, operations) {
	return { checksum: normalized(checksum), operations };
}

function mapOperations(scale) {
	let checksum = 0;
	let operations = 0;
	for (let round = 0; round < 80 * scale; round++) {
		const values = new Map();
		for (let index = 0; index < 2_048; index++) {
			values.set(index, index ^ round);
			operations++;
		}
		for (let index = 0; index < 2_048; index++) {
			checksum += values.has(index) ? values.get(index) : 0;
			operations += 2;
		}
		for (const [key, value] of values) {
			checksum = (checksum + key + value) % MODULUS;
			operations++;
		}
	}
	return result(checksum, operations);
}

runRuntimeGapCase("map-operations", mapOperations);
