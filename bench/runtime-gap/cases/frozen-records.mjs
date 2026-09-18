import { runRuntimeGapCase } from "../case-runner.mjs";

const MODULUS = 1_000_000_007;

function normalized(value) {
	const result = value % MODULUS;
	return result < 0 ? result + MODULUS : result;
}

function result(checksum, operations) {
	return { checksum: normalized(checksum), operations };
}

function frozenRecords(scale) {
	let checksum = 0;
	const operations = 90_000 * scale;
	for (let index = 0; index < operations; index++) {
		const record = Object.freeze({ id: index, kind: index & 31, value: index * 3 });
		checksum = (checksum + record.id + record.kind + record.value) % MODULUS;
	}
	return result(checksum, operations);
}

runRuntimeGapCase("frozen-records", frozenRecords);
