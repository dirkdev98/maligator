import { runRuntimeGapCase } from "../case-runner.mjs";

const MODULUS = 1_000_000_007;

function normalized(value) {
	const result = value % MODULUS;
	return result < 0 ? result + MODULUS : result;
}

function result(checksum, operations) {
	return { checksum: normalized(checksum), operations };
}

function optimizerQueueReplay(scale) {
	const pending = new Uint8Array(16_384);
	const queue = new Uint32Array(16_384);
	let checksum = 0;
	let operations = 0;
	for (let round = 0; round < 120 * scale; round++) {
		let length = 0;
		for (let index = 0; index < pending.length; index += 3) {
			if (pending[index] !== 0) continue;
			pending[index] = 1;
			queue[length++] = index;
			operations++;
		}
		for (let cursor = 0; cursor < length; cursor++) {
			const value = queue[cursor];
			pending[value] = 0;
			checksum = (checksum + value) % MODULUS;
			operations++;
		}
	}
	return result(checksum, operations);
}

runRuntimeGapCase("optimizer-queue", optimizerQueueReplay);
