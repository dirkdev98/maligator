import { runRuntimeGapCase } from "../case-runner.mjs";

const MODULUS = 1_000_000_007;

function normalized(value) {
	const result = value % MODULUS;
	return result < 0 ? result + MODULUS : result;
}

function result(checksum, operations) {
	return { checksum: normalized(checksum), operations };
}

function lowRetentionChurn(scale) {
	let checksum = 0;
	const operations = 500_000 * scale;
	for (let index = 0; index < operations; index++) {
		const row = [index, index + 1, index + 2, index + 3];
		checksum = (checksum + row[0] + row[3]) % MODULUS;
	}
	return result(checksum, operations);
}

runRuntimeGapCase("low-retention-churn", lowRetentionChurn);
