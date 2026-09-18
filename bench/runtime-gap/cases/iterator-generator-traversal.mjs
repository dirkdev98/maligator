import { runRuntimeGapCase } from "../case-runner.mjs";

const MODULUS = 1_000_000_007;

function normalized(value) {
	const result = value % MODULUS;
	return result < 0 ? result + MODULUS : result;
}

function result(checksum, operations) {
	return { checksum: normalized(checksum), operations };
}

function* numberSequence(seed) {
	for (let index = 0; index < 8; index++) yield seed + index * 3;
}

function iteratorGeneratorTraversal(scale) {
	let checksum = 0;
	const operations = 120_000 * scale * 8;
	for (let round = 0; round < 120_000 * scale; round++) {
		for (const value of numberSequence(round)) checksum = (checksum + value) % MODULUS;
	}
	return result(checksum, operations);
}

runRuntimeGapCase("iterator-generator-traversal", iteratorGeneratorTraversal);
