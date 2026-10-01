import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const keys = [];
	for (let index = 0; index < 16; index++) keys.push({ index });
	const missing = { index: 99 };
	const map = new WeakMap();
	const set = new WeakSet();
	const operations = 2000 * scale;
	let checksum = 0;
	for (let round = 0; round < operations; round++) {
		const key = keys[round & 15];
		const assigned = map.set(key, round + key.index);
		const added = set.add(key);
		const present = map.has(key);
		const value = map.get(key);
		const retained = set.has(key);
		const absent = set.has(missing);
		const removed = map.delete(key);
		const deleted = map.has(key);
		if (
			assigned !== map ||
			added !== set ||
			!present ||
			!retained ||
			absent ||
			!removed ||
			deleted
		)
			throw new Error("weak collection state failed");
		checksum += value + key.index + 7;
	}
	return { checksum: checksum % 1000000007, operations };
}

runRuntimeGapCase("primordial-weakmap-retained-keys", run);
