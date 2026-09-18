import { runRuntimeGapCase } from "../case-runner.mjs";

const MODULUS = 1_000_000_007;

function normalized(value) {
	const result = value % MODULUS;
	return result < 0 ? result + MODULUS : result;
}

function result(checksum, operations) {
	return { checksum: normalized(checksum), operations };
}

function immediateDominatorsReplay(scale) {
	const blocks = 16_384;
	const dominators = new Int32Array(blocks);
	let checksum = 0;
	const operations = blocks * 50 * scale;
	for (let round = 0; round < 50 * scale; round++) {
		dominators[0] = 0;
		for (let block = 1; block < blocks; block++) {
			const first = block - 1;
			const second = block > 2 && (block & 3) === 0 ? block - 3 : first;
			let finger = first;
			while (finger > second) finger = dominators[finger];
			dominators[block] = finger;
			checksum = (checksum + finger + block) % MODULUS;
		}
	}
	return result(checksum, operations);
}

runRuntimeGapCase("immediate-dominators", immediateDominatorsReplay);
