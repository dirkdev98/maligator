import { runRuntimeGapCase } from "../case-runner.mjs";
function transform(input, output, count, limit) {
	for (let index = 0; index < count; index++)
		output[index] = Math.fround(
			Math.max(-limit, Math.min(Math.round(input[index]), limit)),
		);
}
function norm(input, count) {
	let total = 0;
	for (let index = 0; index < count; index++) total += Math.abs(input[index]);
	return total;
}
function run(scale) {
	const input = Float64Array.from({ length: 256 }, (_, index) => (index & 63) - 31.5);
	const output = new Float32Array(256);
	let checksum = 0;
	const rounds = 5000 * scale;
	for (let index = 0; index < rounds; index++) {
		transform(input, output, 256, 17.5);
		checksum = (checksum + norm(output, 256) * 2) | 0;
	}
	return { checksum: checksum >>> 0, operations: rounds * 512 };
}
runRuntimeGapCase("typed-array-math-regions", run);
