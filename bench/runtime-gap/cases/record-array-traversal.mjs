import { runRuntimeGapCase } from "../case-runner.mjs";

const MODULUS = 1_000_000_007;

function normalized(value) {
	const result = value % MODULUS;
	return result < 0 ? result + MODULUS : result;
}

function result(checksum, operations) {
	return { checksum: normalized(checksum), operations };
}

function recordArrayTraversal(scale) {
	const rows = Array.from({ length: 8_192 }, (_, index) => ({
		left: index & 1_023,
		right: (index * 17) & 1_023,
		kind: index & 31,
	}));
	let checksum = 0;
	const rounds = 100 * scale;
	for (let round = 0; round < rounds; round++) {
		for (const row of rows) checksum += row.left + row.right + row.kind;
	}
	return result(checksum, rows.length * rounds);
}

runRuntimeGapCase("record-array-traversal", recordArrayTraversal);
