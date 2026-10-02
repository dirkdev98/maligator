import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const sizes = [0, 1, 2, 3, 4, 8];
	const choices = [
		Array.from({ length: 8 }, (_, index) => index),
		Array.from({ length: 8 }, (_, index) => "key-" + index),
		Array.from({ length: 8 }, () => ({})),
		[0, "key", null, 1n, true, undefined, Symbol("key"), {}],
	];
	let checksum = 0;
	let operations = 0;
	for (let round = 0; round < 6000 * scale; round++) {
		const keys = choices[round & 3];
		const count = sizes[round % sizes.length];
		const map = new Map();
		for (let index = 0; index < count; index++) {
			map.set(keys[index], index + round);
			operations++;
		}
		for (let index = 0; index < count; index++) {
			checksum += map.get(keys[index]);
			map.set(keys[index], index + 1);
			operations += 2;
		}
		if (count !== 0) {
			if (!map.delete(keys[0])) throw new Error("tiny deletion lost key");
			map.set(keys[0], 1);
			operations += 2;
		}
		let visited = 0;
		for (const value of map.values()) {
			checksum += value * ++visited;
			operations++;
		}
		if (visited !== count) throw new Error("tiny iteration lost pair");
	}
	return { checksum: checksum % 1000000007, operations };
}
runRuntimeGapCase("map-small-lifecycle", run);
