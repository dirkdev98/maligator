import { runRuntimeGapCase } from "../case-runner.mjs";

function combine(left, right, output, end) {
	for (let index = 1; index < end; index++)
		output[index - 1] = left[index - 1] + right[index + 1];
}

function run(scale) {
	const left = new Float64Array(4098);
	const right = new Float64Array(4098);
	const output = new Float64Array(4096);
	for (let index = 0; index < left.length; index++) {
		left[index] = (index % 31) * 0.25;
		right[index] = (index % 17) * 0.5;
	}
	const rounds = 300 * scale;
	let checksum = 0;
	for (let round = 0; round < rounds; round++) {
		combine(left, right, output, output.length + 1);
		checksum += output[round % output.length];
	}
	return { checksum, operations: rounds * output.length };
}

runRuntimeGapCase("typed-array-affine-window", run);
