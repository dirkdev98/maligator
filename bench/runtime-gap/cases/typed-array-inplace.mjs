import { runRuntimeGapCase } from "../case-runner.mjs";

function update(data, end, scale, bias) {
	for (let index = 0; index < end; index++) data[index] = data[index] * scale + bias;
}

function run(scale) {
	const data = new Float64Array(4096);
	for (let index = 0; index < data.length; index++) data[index] = index % 31;
	const rounds = 300 * scale;
	let checksum = 0;
	for (let round = 0; round < rounds; round++) {
		update(data, data.length, 0.5, 1);
		checksum += data[round % data.length];
	}
	return { checksum, operations: rounds * data.length };
}

runRuntimeGapCase("typed-array-inplace", run);
