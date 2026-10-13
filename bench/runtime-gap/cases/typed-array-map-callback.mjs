import { runRuntimeGapCase } from "../case-runner.mjs";

function mapBatch(values, factor) {
	return values.map(function transformTyped(value) {
		let result = value * factor;
		for (let repeat = 0; repeat < 2; repeat++) result += value;
		return result + arguments[1] + arguments.length;
	});
}

function run(scale) {
	const input = new Float64Array(512);
	for (let index = 0; index < input.length; index++) input[index] = index * 0.25;
	const rounds = 300 * scale;
	let checksum = 0;
	for (let round = 0; round < rounds; round++) {
		const output = mapBatch(input, 1 + (round & 3));
		checksum += output[round % output.length];
	}
	return { checksum, operations: rounds * input.length };
}

runRuntimeGapCase("typed-array-map-callback", run);
