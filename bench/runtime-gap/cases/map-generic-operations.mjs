import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const keys = [
		0,
		-1,
		0.5,
		NaN,
		Infinity,
		1n,
		"generic",
		true,
		undefined,
		null,
		Symbol("key"),
		{},
	];
	let checksum = 0;
	let operations = 0;
	for (let round = 0; round < 10000 * scale; round++) {
		const map = new Map();
		for (let index = 0; index < keys.length; index++) {
			map.set(keys[index], { index });
			operations++;
		}
		for (let index = 0; index < keys.length; index++) {
			const value = map.get(keys[index]);
			if (value.index !== index) throw new Error("generic value lost");
			checksum += value.index;
			operations++;
			if ((index & 3) === 0) {
				map.delete(keys[index]);
				map.set(keys[index], value);
				operations += 2;
			}
		}
		let count = 0;
		for (const value of map.values()) {
			checksum += value.index * ++count;
			operations++;
		}
		if (count !== keys.length) throw new Error("generic traversal lost pair");
	}
	return { checksum: checksum % 1000000007, operations };
}
runRuntimeGapCase("map-generic-operations", run);
