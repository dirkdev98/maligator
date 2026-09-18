import { runRuntimeGapCase } from "../case-runner.mjs";

const MODULUS = 1_000_000_007;

function normalized(value) {
	const result = value % MODULUS;
	return result < 0 ? result + MODULUS : result;
}

function result(checksum, operations) {
	return { checksum: normalized(checksum), operations };
}

function stringSearch(scale) {
	const value = `${"abcdef0123456789".repeat(64)}target:${"uvwxyz".repeat(32)}`;
	let checksum = 0;
	const operations = 180_000 * scale;
	for (let index = 0; index < operations; index++) {
		checksum += value.indexOf(index & 1 ? "target:" : "not-present");
	}
	return result(checksum, operations);
}

runRuntimeGapCase("string-search", stringSearch);
