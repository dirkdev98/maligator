import { runRuntimeGapCase } from "../case-runner.mjs";

const MODULUS = 1_000_000_007;

function normalized(value) {
	const result = value % MODULUS;
	return result < 0 ? result + MODULUS : result;
}

function result(checksum, operations) {
	return { checksum: normalized(checksum), operations };
}

function arrayFilter(scale) {
	const values = Array.from({ length: 1_024 }, (_, index) => index);
	let checksum = 0;
	const rounds = 120 * scale;
	for (let round = 0; round < rounds; round++) {
		const filtered = values.filter((value) => (value & 7) === (round & 7));
		checksum += filtered.length + filtered[round & 127];
	}
	return result(checksum, values.length * rounds);
}

runRuntimeGapCase("array-filter", arrayFilter);
