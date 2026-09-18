import { runRuntimeGapCase } from "../case-runner.mjs";

const MODULUS = 1_000_000_007;

function normalized(value) {
	const result = value % MODULUS;
	return result < 0 ? result + MODULUS : result;
}

function result(checksum, operations) {
	return { checksum: normalized(checksum), operations };
}

function arrayMap(scale) {
	const values = Array.from({ length: 1_024 }, (_, index) => index);
	let checksum = 0;
	const rounds = 120 * scale;
	for (let round = 0; round < rounds; round++) {
		const mapped = values.map((value) => value + round);
		checksum += mapped[round & 1_023];
	}
	return result(checksum, values.length * rounds);
}

runRuntimeGapCase("array-map", arrayMap);
