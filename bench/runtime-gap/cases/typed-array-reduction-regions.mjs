import { runRuntimeGapCase } from "../case-runner.mjs";
function sum(data, count) {
	let total = 0;
	for (let index = 0; index < count; index++) total += data[index];
	return total;
}
function dot(left, right, count) {
	let total = 0;
	for (let index = count - 1; index >= 0; index--) total += left[index] * right[index];
	return total;
}
function run(scale) {
	const left = new Float64Array(256),
		right = new Float64Array(256);
	for (let index = 0; index < left.length; index++) {
		left[index] = (index & 31) - 7.5;
		right[index] = (index & 7) + 0.5;
	}
	let checksum = 0;
	const rounds = 10000 * scale;
	for (let index = 0; index < rounds; index++)
		checksum = (checksum + sum(left, 256) + dot(left, right, 256)) | 0;
	return { checksum: checksum >>> 0, operations: rounds * 512 };
}
runRuntimeGapCase("typed-array-reduction-regions", run);
