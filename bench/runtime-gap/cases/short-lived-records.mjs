import { runRuntimeGapCase } from "../case-runner.mjs";

const MODULUS = 1_000_000_007;

function normalized(value) {
	const result = value % MODULUS;
	return result < 0 ? result + MODULUS : result;
}

function result(checksum, operations) {
	return { checksum: normalized(checksum), operations };
}

function shortLivedRecords(scale) {
	let checksum = 0;
	const operations = 350_000 * scale;
	for (let index = 0; index < operations; index++) {
		const record = {
			id: index,
			left: index & 1_023,
			right: (index * 17) & 1_023,
			kind: index & 31,
		};
		checksum =
			(checksum + record.id + record.left - record.right + record.kind) % MODULUS;
	}
	return result(checksum, operations);
}

runRuntimeGapCase("short-lived-records", shortLivedRecords);
