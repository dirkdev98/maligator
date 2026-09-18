import { runRuntimeGapCase } from "../case-runner.mjs";

const MODULUS = 1_000_000_007;

function normalized(value) {
	const result = value % MODULUS;
	return result < 0 ? result + MODULUS : result;
}

function result(checksum, operations) {
	return { checksum: normalized(checksum), operations };
}

function cfgEdgesReplay(scale) {
	const terminators = Array.from({ length: 8_192 }, (_, block) => ({
		block,
		targets: block + 2 < 8_192 ? [block + 1, block + 2] : [],
	}));
	let checksum = 0;
	let operations = 0;
	for (let round = 0; round < 35 * scale; round++) {
		const predecessors = Array.from({ length: terminators.length }, () => []);
		for (const terminator of terminators) {
			for (const target of terminator.targets) {
				predecessors[target].push(terminator.block);
				checksum = (checksum + target + terminator.block) % MODULUS;
				operations++;
			}
		}
	}
	return result(checksum, operations);
}

runRuntimeGapCase("cfg-edges", cfgEdgesReplay);
