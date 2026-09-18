import { runRuntimeGapCase } from "../case-runner.mjs";

const MODULUS = 1_000_000_007;

function normalized(value) {
	const result = value % MODULUS;
	return result < 0 ? result + MODULUS : result;
}

function result(checksum, operations) {
	return { checksum: normalized(checksum), operations };
}

function programFlowExtractionReplay(scale) {
	let checksum = 0;
	let operations = 0;
	for (let round = 0; round < 45 * scale; round++) {
		const rows = new Map();
		for (let caller = 0; caller < 12_000; caller++) {
			const targets = [];
			for (let edge = 0; edge < 4; edge++)
				targets.push((caller * 17 + edge * 31) % 12_000);
			rows.set(caller, targets);
			checksum = (checksum + targets[round & 3]) % MODULUS;
			operations += 5;
		}
	}
	return result(checksum, operations);
}

runRuntimeGapCase("program-flow-extraction", programFlowExtractionReplay);
