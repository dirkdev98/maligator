import { runRuntimeGapCase } from "../case-runner.mjs";

function combine(left, right, output, count) {
	for (let index = 0; index < count; index++) output[index] = left[index] + right[index];
}

function run(scale) {
	const left = new Float32Array(4096);
	const right = new Float32Array(4096);
	const output = new Float32Array(4096);
	for (let index = 0; index < left.length; index++) {
		left[index] = (index % 31) / 3;
		right[index] = (index % 17) / 7;
	}
	const rounds = 300 * scale;
	let checksum = 0;
	for (let round = 0; round < rounds; round++) {
		combine(left, right, output, output.length);
		checksum = (checksum + output[round % output.length]) % 1000000007;
	}
	return { checksum, operations: rounds * output.length };
}

runRuntimeGapCase("typed-array-three-view-f32", run);
