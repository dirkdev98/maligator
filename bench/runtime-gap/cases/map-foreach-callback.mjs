import { runRuntimeGapCase } from "../case-runner.mjs";

function sumMap(entries, factor) {
	const values = new Map(entries);
	let total = 0;
	values.forEach(function accumulate(value, key, receiver) {
		total += value * factor + key.length + (receiver === values ? arguments.length : 0);
	});
	return total;
}

function run(scale) {
	const entries = [];
	for (let index = 0; index < 256; index++) entries.push(["key" + index, index * 0.25]);
	const rounds = 1000 * scale;
	let checksum = 0;
	for (let round = 0; round < rounds; round++) checksum += sumMap(entries, 1.25);
	return { checksum, operations: rounds * entries.length };
}

runRuntimeGapCase("map-foreach-callback", run);
