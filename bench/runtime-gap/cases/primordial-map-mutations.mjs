import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const keys = ["a", "b", "c", "d", "e", "f", "g", "h", 0, 1, 2, 3, {}, {}, {}, {}];
	const missing = {};
	const map = new Map();
	const operations = 1000 * scale;
	let checksum = 0;
	for (let round = 0; round < operations; round++) {
		for (let index = 0; index < keys.length; index++) map.set(keys[index], round + index);
		if (map.has(missing) || map.get(missing) !== undefined)
			throw new Error("map miss mismatch");
		for (let index = 0; index < keys.length; index++) {
			const present = map.has(keys[index]);
			const value = map.get(keys[index]);
			if (!present || value !== round + index) throw new Error("map read mismatch");
			checksum += value;
			if ((index & 1) === 0) {
				if (!map.delete(keys[index]) || map.has(keys[index]))
					throw new Error("map deletion mismatch");
				checksum++;
			}
		}
		map.clear();
		if (map.size !== 0) throw new Error("map clear mismatch");
	}
	return { checksum: checksum % 1000000007, operations };
}

runRuntimeGapCase("primordial-map-mutations", run);
