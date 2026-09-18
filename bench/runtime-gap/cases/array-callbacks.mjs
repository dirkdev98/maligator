import { runRuntimeGapCase } from "../case-runner.mjs";

const MODULUS = 1_000_000_007;

function normalized(value) {
	const result = value % MODULUS;
	return result < 0 ? result + MODULUS : result;
}

function result(checksum, operations) {
	return { checksum: normalized(checksum), operations };
}

function arrayCallbacks(scale) {
	const values = Array.from({ length: 1_024 }, (_, index) => index);
	let checksum = 0;
	let operations = 0;
	for (let round = 0; round < 160 * scale; round++) {
		const mapped = values.map((value) => value + round);
		const filtered = mapped.filter((value) => (value & 3) === 0);
		checksum += filtered.find((value) => value > 700) ?? 0;
		checksum += filtered.some((value) => value === round + 512) ? 1 : 0;
		checksum += filtered.includes(round + 768) ? 1 : 0;
		operations += values.length * 2 + filtered.length * 3;
	}
	return result(checksum, operations);
}

runRuntimeGapCase("array-callbacks", arrayCallbacks);
