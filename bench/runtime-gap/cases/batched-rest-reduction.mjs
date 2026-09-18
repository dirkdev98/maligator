import { runRuntimeGapCase } from "../case-runner.mjs";

const MODULUS = 1_000_000_007;

function normalized(value) {
	const result = value % MODULUS;
	return result < 0 ? result + MODULUS : result;
}

function result(checksum, operations) {
	return { checksum: normalized(checksum), operations };
}

function reduceRestBatch(rounds, ...values) {
	let checksum = 0;
	for (let round = 0; round < rounds; round++) {
		for (let index = 0; index < values.length; index++) checksum += values[index];
	}
	return checksum;
}

function batchedRestReduction(scale) {
	let checksum = 0;
	const batches = 250 * scale;
	const rounds = 256;
	for (let batch = 0; batch < batches; batch++) {
		checksum += reduceRestBatch(rounds, batch & 31, 3, 5, 7);
	}
	return result(checksum, batches * rounds * 4);
}

runRuntimeGapCase("batched-rest-reduction", batchedRestReduction);
