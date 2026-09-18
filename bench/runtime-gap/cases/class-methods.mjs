import { runRuntimeGapCase } from "../case-runner.mjs";

const MODULUS = 1_000_000_007;

function normalized(value) {
	const result = value % MODULUS;
	return result < 0 ? result + MODULUS : result;
}

function result(checksum, operations) {
	return { checksum: normalized(checksum), operations };
}

class Counter {
	constructor(offset) {
		this.offset = offset;
	}
	add(value) {
		return value + this.offset;
	}
}

function classMethods(scale) {
	const counters = Array.from({ length: 32 }, (_, index) => new Counter(index));
	let checksum = 0;
	const operations = 700_000 * scale;
	for (let index = 0; index < operations; index++) {
		checksum += counters[index & 31].add(index & 255);
	}
	return result(checksum, operations);
}

runRuntimeGapCase("class-methods", classMethods);
