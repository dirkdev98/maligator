import { runRuntimeGapCase } from "../case-runner.mjs";

const MODULUS = 1_000_000_007;

function normalized(value) {
	const result = value % MODULUS;
	return result < 0 ? result + MODULUS : result;
}

function result(checksum, operations) {
	return { checksum: normalized(checksum), operations };
}

function forOfCollections(scale) {
	const array = Array.from({ length: 512 }, (_, index) => index * 3);
	const map = new Map(array.map((value, index) => [index, value]));
	const set = new Set(array);
	let checksum = 0;
	for (let round = 0; round < 300 * scale; round++) {
		for (const value of array) checksum = (checksum + value) % MODULUS;
		for (const [key, value] of map) checksum = (checksum + key + value) % MODULUS;
		for (const value of set) checksum = (checksum + value) % MODULUS;
	}
	return result(checksum, array.length * 3 * 300 * scale);
}

runRuntimeGapCase("for-of-collections", forOfCollections);
