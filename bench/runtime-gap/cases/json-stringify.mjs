import { runRuntimeGapCase } from "../case-runner.mjs";

const MODULUS = 1_000_000_007;

function normalized(value) {
	const result = value % MODULUS;
	return result < 0 ? result + MODULUS : result;
}

function result(checksum, operations) {
	return { checksum: normalized(checksum), operations };
}

function jsonStringify(scale) {
	const rows = Array.from({ length: 64 }, (_, id) => ({
		id,
		value: id * 17,
		active: (id & 3) !== 0,
	}));
	let checksum = 0;
	const operations = 8_000 * scale;
	for (let index = 0; index < operations; index++) {
		checksum += JSON.stringify(rows).length + (index & 1);
	}
	return result(checksum, operations);
}

runRuntimeGapCase("json-stringify", jsonStringify);
