import { runRuntimeGapCase } from "../case-runner.mjs";

function sumMap(values, rounds, factor) {
	let total = 0;
	for (let round = 0; round < rounds; round++) {
		values.forEach(function accumulate(value, key, receiver) {
			total += value * factor + key.length + (receiver === values ? arguments.length : 0);
		});
	}
	return total;
}

function run(scale) {
	const values = new Map();
	for (let index = 0; index < 256; index++) values.set("key" + index, index * 0.25);
	const rounds = 1000 * scale;
	return { checksum: sumMap(values, rounds, 1.25), operations: rounds * values.size };
}

runRuntimeGapCase("map-foreach-loop-callback", run);
