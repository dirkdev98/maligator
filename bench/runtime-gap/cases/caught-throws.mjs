import { runRuntimeGapCase } from "../case-runner.mjs";

const MODULUS = 1_000_000_007;

function normalized(value) {
	const result = value % MODULUS;
	return result < 0 ? result + MODULUS : result;
}

function result(checksum, operations) {
	return { checksum: normalized(checksum), operations };
}

function caughtThrows(scale) {
	let checksum = 0;
	const operations = 20_000 * scale;
	for (let index = 0; index < operations; index++) {
		try {
			throw index & 255;
		} catch (value) {
			checksum += value;
		}
	}
	return result(checksum, operations);
}

runRuntimeGapCase("caught-throws", caughtThrows);
