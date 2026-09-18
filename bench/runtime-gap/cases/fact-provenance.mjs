import { runRuntimeGapCase } from "../case-runner.mjs";

const MODULUS = 1_000_000_007;

function normalized(value) {
	const result = value % MODULUS;
	return result < 0 ? result + MODULUS : result;
}

function result(checksum, operations) {
	return { checksum: normalized(checksum), operations };
}

function provenanceReplay(scale) {
	const facts = new Map();
	let checksum = 0;
	let operations = 0;
	for (let round = 0; round < 45 * scale; round++) {
		facts.clear();
		for (let value = 0; value < 24_000; value++) {
			const source = value === 0 ? 0 : (value * 17) % value;
			const fact = (facts.get(source) ?? source & 31) | (1 << (value & 7));
			facts.set(value, fact);
			checksum = (checksum + fact) % MODULUS;
			operations += 2;
		}
	}
	return result(checksum, operations);
}

runRuntimeGapCase("fact-provenance", provenanceReplay);
