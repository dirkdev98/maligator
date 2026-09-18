import { runRuntimeGapCase } from "../case-runner.mjs";

const MODULUS = 1_000_000_007;

function normalized(value) {
	const result = value % MODULUS;
	return result < 0 ? result + MODULUS : result;
}

function result(checksum, operations) {
	return { checksum: normalized(checksum), operations };
}

function stableShapeProperties(scale) {
	const values = Array.from({ length: 2_048 }, (_, index) => ({
		id: index,
		kind: index & 15,
		generation: index & 255,
		flags: 0,
	}));
	let checksum = 0;
	const operations = values.length * 120 * scale * 4;
	for (let round = 0; round < 120 * scale; round++) {
		for (const value of values) {
			value.flags = value.kind ^ round;
			checksum = (checksum + value.id + value.generation + value.flags) % MODULUS;
		}
	}
	return result(checksum, operations);
}

runRuntimeGapCase("stable-shape-properties", stableShapeProperties);
