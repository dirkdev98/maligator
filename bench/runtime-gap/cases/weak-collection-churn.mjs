import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const map = new WeakMap();
	const set = new WeakSet();
	const keys = Array.from({ length: 64 }, (_, index) => ({ index }));
	for (const key of keys) {
		map.set(key, key.index);
		set.add(key);
	}
	let checksum = 0;
	const rounds = 100000 * scale;
	for (let round = 0; round < rounds; round++) {
		const index = round & 63;
		const old = keys[index];
		checksum += map.get(old);
		if (!set.has(old) || !map.delete(old) || !set.delete(old))
			throw new Error("weak removal lost key");
		const key = { index: round & 1023 };
		keys[index] = key;
		map.set(key, key.index);
		set.add(key);
	}
	for (const key of keys) {
		if (!set.has(key)) throw new Error("weak current member missing");
		checksum += map.get(key);
	}
	return { checksum: checksum % 1000000007, operations: rounds * 6 + 128 };
}
runRuntimeGapCase("weak-collection-churn", run);
