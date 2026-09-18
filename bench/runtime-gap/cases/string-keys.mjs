import { runRuntimeGapCase } from "../case-runner.mjs";

const MODULUS = 1_000_000_007;

function normalized(value) {
	const result = value % MODULUS;
	return result < 0 ? result + MODULUS : result;
}

function result(checksum, operations) {
	return { checksum: normalized(checksum), operations };
}

function stringKeys(scale) {
	let checksum = 0;
	const values = new Map();
	const operations = 180_000 * scale;
	for (let index = 0; index < operations; index++) {
		const key = `function:${index & 1_023}:block:${(index * 17) & 255}`;
		values.set(key, (values.get(key) ?? 0) + 1);
		checksum = (checksum + key.length + values.get(key)) % MODULUS;
	}
	return result(checksum, operations * 3);
}

runRuntimeGapCase("string-keys", stringKeys);
