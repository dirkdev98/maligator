import { runRuntimeGapCase } from "../case-runner.mjs";

const MODULUS = 1_000_000_007;

function normalized(value) {
	const result = value % MODULUS;
	return result < 0 ? result + MODULUS : result;
}

function result(checksum, operations) {
	return { checksum: normalized(checksum), operations };
}

function moderateRetentionChurn(scale) {
	let checksum = 0;
	const retained = [];
	const operations = 400_000 * scale;
	for (let index = 0; index < operations; index++) {
		const row = {
			id: index,
			operands: [index & 255, (index + 1) & 255],
			flags: index & 31,
		};
		if ((index & 31) === 0) retained.push(row);
		checksum = (checksum + row.id + row.operands[1] + row.flags) % MODULUS;
	}
	for (const row of retained) checksum = (checksum + row.id) % MODULUS;
	return result(checksum, operations + retained.length);
}

runRuntimeGapCase("moderate-retention-churn", moderateRetentionChurn);
