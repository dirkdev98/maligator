import { runRuntimeGapCase } from "../case-runner.mjs";

const MODULUS = 1_000_000_007;

function normalized(value) {
	const result = value % MODULUS;
	return result < 0 ? result + MODULUS : result;
}

function result(checksum, operations) {
	return { checksum: normalized(checksum), operations };
}

function stringSplit(scale) {
	const value = Array.from({ length: 128 }, (_, index) => `field-${index}`).join(",");
	let checksum = 0;
	const operations = 30_000 * scale;
	for (let index = 0; index < operations; index++) {
		const fields = value.split(",");
		checksum += fields[index & 127].length + fields.length;
	}
	return result(checksum, operations);
}

runRuntimeGapCase("string-split", stringSplit);
