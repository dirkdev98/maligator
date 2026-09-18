import { runRuntimeGapCase } from "../case-runner.mjs";

const MODULUS = 1_000_000_007;

function normalized(value) {
	const result = value % MODULUS;
	return result < 0 ? result + MODULUS : result;
}

function result(checksum, operations) {
	return { checksum: normalized(checksum), operations };
}

function polymorphicProperties(scale) {
	const rows = Array.from({ length: 4_096 }, (_, index) =>
		index & 1 ? { value: index, left: 1 } : { value: index, right: 2 },
	);
	let checksum = 0;
	const rounds = 150 * scale;
	for (let round = 0; round < rounds; round++) {
		for (const row of rows) checksum += row.value;
	}
	return result(checksum, rows.length * rounds);
}

runRuntimeGapCase("polymorphic-properties", polymorphicProperties);
