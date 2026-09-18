import { runRuntimeGapCase } from "../case-runner.mjs";

const MODULUS = 1_000_000_007;

function normalized(value) {
	const result = value % MODULUS;
	return result < 0 ? result + MODULUS : result;
}

function result(checksum, operations) {
	return { checksum: normalized(checksum), operations };
}

function prunedSsaReplay(scale) {
	const definitions = new Int32Array(4_096);
	definitions.fill(-1);
	const incomplete = new Map();
	let checksum = 0;
	let operations = 0;
	for (let round = 0; round < 160 * scale; round++) {
		for (let index = 0; index < definitions.length; index += 3) {
			definitions[index] = round + index;
			operations++;
		}
		for (let index = 0; index < definitions.length; index++) {
			const value = definitions[index];
			if (value === -1) incomplete.set(index, round);
			else checksum = (checksum + value) % MODULUS;
			operations++;
		}
		incomplete.clear();
	}
	return result(checksum, operations);
}

runRuntimeGapCase("pruned-ssa", prunedSsaReplay);
