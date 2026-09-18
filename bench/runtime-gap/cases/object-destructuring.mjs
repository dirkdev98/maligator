import { runRuntimeGapCase } from "../case-runner.mjs";

const MODULUS = 1_000_000_007;

function normalized(value) {
	const result = value % MODULUS;
	return result < 0 ? result + MODULUS : result;
}

function result(checksum, operations) {
	return { checksum: normalized(checksum), operations };
}

function objectDestructuring(scale) {
	const values = Array.from({ length: 2_048 }, (_, index) => ({
		left: index,
		right: index * 3,
		ignored: index * 7,
	}));
	let checksum = 0;
	const rounds = 180 * scale;
	for (let round = 0; round < rounds; round++) {
		for (const { left, right } of values) checksum += left ^ right ^ round;
	}
	return result(checksum, values.length * rounds);
}

runRuntimeGapCase("object-destructuring", objectDestructuring);
