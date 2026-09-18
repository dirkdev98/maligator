import { runRuntimeGapCase } from "../case-runner.mjs";

const MODULUS = 1_000_000_007;

function normalized(value) {
	const result = value % MODULUS;
	return result < 0 ? result + MODULUS : result;
}

function result(checksum, operations) {
	return { checksum: normalized(checksum), operations };
}

function spreadCopies(scale) {
	const template = { kind: 7, flags: 3, generation: 11, block: 13, value: 17 };
	let checksum = 0;
	const operations = 100_000 * scale;
	for (let index = 0; index < operations; index++) {
		const copy = { ...template, value: index, next: index + 1 };
		checksum = (checksum + copy.kind + copy.flags + copy.value + copy.next) % MODULUS;
	}
	return result(checksum, operations);
}

runRuntimeGapCase("spread-copies", spreadCopies);
