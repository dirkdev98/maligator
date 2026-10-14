import { runRuntimeGapCase } from "../case-runner.mjs";
function transform(left, right, output, count) {
	for (let index = 0; index < count; index++)
		output[index] = Math.f16round(
			Math.max(
				-2048,
				Math.min(
					Math.imul(left[index], right[index]) + Math.clz32(left[index]),
					2048,
					4096,
				),
				-4096,
			),
		);
}
function run(scale) {
	const left = Int32Array.from({ length: 256 }, (_, index) => (index & 63) - 31);
	const right = Int32Array.from({ length: 256 }, (_, index) => (index & 7) + 3);
	const output = new Float32Array(256);
	let checksum = 0;
	const rounds = 5000 * scale;
	for (let index = 0; index < rounds; index++) {
		transform(left, right, output, 256);
		checksum = (checksum + output[index & 255]) | 0;
	}
	return { checksum: checksum >>> 0, operations: rounds * 256 };
}
runRuntimeGapCase("typed-array-math-kernels", run);
