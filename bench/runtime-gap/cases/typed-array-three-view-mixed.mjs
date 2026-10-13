import { runRuntimeGapCase } from "../case-runner.mjs";

function combine(left, right, output, count) {
	for (let index = 0; index < count; index++) output[index] = left[index] + right[index];
}

function run(scale) {
	const left = new Int32Array(4096);
	const right = new Uint32Array(4096);
	const output = new Float32Array(4096);
	for (let index = 0; index < left.length; index++) {
		left[index] = -2147483648 + (index % 31) * 257;
		right[index] = 4294967295 - (index % 17) * 129;
	}
	const rounds = 300 * scale;
	let checksum = 0;
	for (let round = 0; round < rounds; round++) {
		combine(left, right, output, output.length);
		checksum = (checksum + output[round % output.length]) % 1000000007;
	}
	return { checksum, operations: rounds * output.length };
}

runRuntimeGapCase("typed-array-three-view-mixed", run);
