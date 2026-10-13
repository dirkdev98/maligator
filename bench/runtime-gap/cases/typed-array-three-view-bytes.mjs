import { runRuntimeGapCase } from "../case-runner.mjs";

function combine(left, right, output, count) {
	for (let index = 0; index < count; index++) output[index] = left[index] + right[index];
}

function run(scale) {
	const left = new Int16Array(4096);
	const right = new Uint8Array(4096);
	const output = new Uint8ClampedArray(4096);
	for (let index = 0; index < left.length; index++) {
		left[index] = (index % 31) * 17 - 255;
		right[index] = (index % 17) * 13;
	}
	const rounds = 300 * scale;
	let checksum = 0;
	for (let round = 0; round < rounds; round++) {
		combine(left, right, output, output.length);
		checksum += output[round % output.length];
	}
	return { checksum, operations: rounds * output.length };
}

runRuntimeGapCase("typed-array-three-view-bytes", run);
