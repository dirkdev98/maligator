import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const sizes = [0, 1, 2, 3, 4, 8];
	const objectKeys = Array.from({ length: 8 }, () => ({}));
	const symbolKeys = Array.from({ length: 8 }, (_, index) => Symbol("key-" + index));
	let checksum = 0;
	let operations = 0;
	for (let round = 0; round < 6000 * scale; round++) {
		const keys = (round & 1) === 0 ? objectKeys : symbolKeys;
		const count = sizes[round % sizes.length];
		const map = new WeakMap();
		const set = new WeakSet();
		for (let index = 0; index < count; index++) {
			map.set(keys[index], index + round);
			set.add(keys[index]);
			operations += 2;
		}
		for (let index = 0; index < count; index++) {
			if (!set.has(keys[index]) || !map.has(keys[index]))
				throw new Error("weak tiny key missing");
			checksum += map.get(keys[index]);
			map.set(keys[index], index + 1);
			operations += 4;
		}
		if (count !== 0) {
			if (!map.delete(keys[0]) || !set.delete(keys[0]))
				throw new Error("weak tiny deletion failed");
			map.set(keys[0], 1);
			set.add(keys[0]);
			operations += 4;
		}
		for (let index = 0; index < count; index++) {
			checksum += map.get(keys[index]) * (index + 1);
			if (!set.has(keys[index])) throw new Error("weak tiny reinsertion failed");
			operations += 2;
		}
	}
	return { checksum: checksum % 1000000007, operations };
}
runRuntimeGapCase("weak-small-lifecycle", run);
