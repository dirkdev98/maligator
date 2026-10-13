import { runRuntimeGapCase } from "../case-runner.mjs";
function combine(left, right, output, count) {
	for (let index = 0; index < count; index++) output[index] = left[index] + right[index];
}
function run(scale) {
	const left = new Float64Array(4096),
		right = new Float64Array(4096),
		output = new Float64Array(4096);
	for (let index = 0; index < left.length; index++) {
		left[index] = (index % 31) * 0.5;
		right[index] = (index % 17) * 1.25;
	}
	const rounds = 300 * scale;
	let checksum = 0;
	for (let round = 0; round < rounds; round++) {
		combine(left, right, output, output.length);
		checksum = (checksum + output[round % output.length]) % 1000000007;
	}
	return { checksum, operations: rounds * output.length };
}
runRuntimeGapCase("typed-array-three-view", run);
