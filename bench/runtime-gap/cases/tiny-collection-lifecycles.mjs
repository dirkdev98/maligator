import { runRuntimeGapCase } from "../case-runner.mjs";

const MODULUS = 1_000_000_007;
const SIZE_SCHEDULE = [0, 1, 1, 2, 1, 4, 2, 8, 4, 16, 8, 64];

function tinyCollectionLifecycles(scale) {
	let checksum = 0;
	let operations = 0;
	for (let lifecycle = 0; lifecycle < 4_000 * scale; lifecycle++) {
		const size = SIZE_SCHEDULE[lifecycle % SIZE_SCHEDULE.length];
		const values = new Map();
		const relevant = new Set();
		const records = [];
		const states = new Map();
		const block = lifecycle & 63;
		const state = new Map();
		states.set(block, state);
		operations++;
		for (let index = 0; index < size; index++) {
			const key = (lifecycle * 17 + index * 13) & 255;
			const value = lifecycle ^ key;
			values.set(key, value);
			relevant.add(key);
			records.push({ key, value, live: (index & 1) === 0 });
			state.set(key, { version: value, predecessor: index - 1 });
			operations += 4;
		}
		for (let index = 0; index <= size; index++) {
			const key = (lifecycle * 17 + index * 13) & 255;
			if (values.has(key)) checksum += values.get(key);
			if (relevant.has(key)) checksum += key;
			const version = states.get(block)?.get(key);
			if (version !== undefined) checksum += version.version;
			operations += 5;
		}
		for (const [key, value] of values) {
			checksum += key ^ value;
			operations++;
		}
		if (size > 0) {
			const first = records[0];
			values.delete(first.key);
			values.set(first.key, first.value);
			operations += 2;
		}
		checksum = (checksum + records.length + state.size) % MODULUS;
	}
	return { checksum, operations };
}

runRuntimeGapCase("tiny-collection-lifecycles", tinyCollectionLifecycles);
