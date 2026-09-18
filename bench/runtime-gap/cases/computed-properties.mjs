import { runRuntimeGapCase } from "../case-runner.mjs";

const MODULUS = 1_000_000_007;

function normalized(value) {
	const result = value % MODULUS;
	return result < 0 ? result + MODULUS : result;
}

function result(checksum, operations) {
	return { checksum: normalized(checksum), operations };
}

function computedProperties(scale) {
	const rows = Array.from({ length: 2_048 }, (_, index) => ({
		field0: index,
		field1: index + 1,
		field2: index + 2,
		field3: index + 3,
	}));
	const keys = ["field0", "field1", "field2", "field3"];
	let checksum = 0;
	const rounds = 180 * scale;
	for (let round = 0; round < rounds; round++) {
		const key = keys[round & 3];
		for (const row of rows) checksum += row[key];
	}
	return result(checksum, rows.length * rounds);
}

runRuntimeGapCase("computed-properties", computedProperties);
