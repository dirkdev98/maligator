import { runRuntimeGapCase } from "../case-runner.mjs";

function blend(left, right, output, count) {
	for (let i = 0; i < count; i += 4) {
		output[i] = left[i] + right[i];
		output[i + 1] = left[i + 1] + right[i + 1];
		output[i + 2] = left[i + 2] + right[i + 2];
		output[i + 3] = left[i + 3] + right[i + 3];
	}
}
function run(scale) {
	const left = new Float64Array(1024),
		right = new Float64Array(1024),
		output = new Float64Array(1024);
	for (let i = 0; i < left.length; i++) {
		left[i] = i * 0.25;
		right[i] = i * 0.5;
	}
	const rounds = 1000 * scale;
	let checksum = 0;
	for (let round = 0; round < rounds; round++) {
		blend(left, right, output, output.length);
		checksum += output[round & 1023];
	}
	return { checksum, operations: rounds * output.length };
}
runRuntimeGapCase("typed-array-interleaved-four-lane", run);
