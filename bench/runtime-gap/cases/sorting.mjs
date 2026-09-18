import { runRuntimeGapCase } from "../case-runner.mjs";

const MODULUS = 1_000_000_007;

function normalized(value) {
	const result = value % MODULUS;
	return result < 0 ? result + MODULUS : result;
}

function result(checksum, operations) {
	return { checksum: normalized(checksum), operations };
}

function sorting(scale) {
	const seed = Array.from({ length: 1_024 }, (_, index) => (index * 4_099) & 65_535);
	let checksum = 0;
	for (let round = 0; round < 120 * scale; round++) {
		const numeric = seed.slice().sort((left, right) => left - right);
		const keys = seed.map((value, index) => ({
			functionId: value & 255,
			score: value,
			index,
		}));
		keys.sort(
			(left, right) => right.score - left.score || left.functionId - right.functionId,
		);
		checksum = (checksum + numeric[round & 1_023] + keys[round & 1_023].index) % MODULUS;
	}
	return result(checksum, seed.length * 2 * 120 * scale);
}

runRuntimeGapCase("sorting", sorting);
