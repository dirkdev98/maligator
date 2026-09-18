import { runRuntimeGapCase } from "../case-runner.mjs";

const MODULUS = 1_000_000_007;

function normalized(value) {
	const result = value % MODULUS;
	return result < 0 ? result + MODULUS : result;
}

function result(checksum, operations) {
	return { checksum: normalized(checksum), operations };
}

function programFlowConvergenceReplay(scale) {
	const count = 16_384;
	const state = new Uint16Array(count);
	const queue = new Uint32Array(count * 4);
	let checksum = 0;
	let operations = 0;
	for (let round = 0; round < 60 * scale; round++) {
		let length = count;
		for (let index = 0; index < count; index++) queue[index] = index;
		for (let cursor = 0; cursor < length; cursor++) {
			const node = queue[cursor];
			const next = (node + 1) & (count - 1);
			const merged = state[next] | state[node] | (1 << ((node + round) & 15));
			if (merged !== state[next] && length < queue.length) {
				state[next] = merged;
				queue[length++] = next;
			}
			checksum = (checksum + merged) % MODULUS;
			operations++;
		}
	}
	return result(checksum, operations);
}

runRuntimeGapCase("program-flow-convergence", programFlowConvergenceReplay);
