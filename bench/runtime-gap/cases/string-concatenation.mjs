import { runRuntimeGapCase } from "../case-runner.mjs";

const MODULUS = 1_000_000_007;

function normalized(value) {
	const result = value % MODULUS;
	return result < 0 ? result + MODULUS : result;
}

function result(checksum, operations) {
	return { checksum: normalized(checksum), operations };
}

function stringConcatenation(scale) {
	let checksum = 0;
	const operations = 250_000 * scale;
	for (let index = 0; index < operations; index++) {
		const value = "fn:" + (index & 1_023) + ":block:" + ((index * 17) & 255);
		checksum += value.length + value.charCodeAt(value.length - 1);
	}
	return result(checksum, operations);
}

runRuntimeGapCase("string-concatenation", stringConcatenation);
