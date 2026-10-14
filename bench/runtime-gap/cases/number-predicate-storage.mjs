import { runRuntimeGapCase } from "../case-runner.mjs";
function select(left, right, output, count) {
	for (let i = 0; i < count; i++) {
		const x = left[i],
			y = right[i];
		output[i] = Number.isSafeInteger(x) ? y + 1 : y - 1;
	}
	return output;
}
function run(scale) {
	const left = Float64Array.from({ length: 256 }, (_, i) => (i % 3 === 0 ? i + 0.5 : i)),
		right = new Float64Array(256).fill(3),
		output = new Float64Array(256);
	let checksum = 0;
	const rounds = 1000 * scale;
	for (let i = 0; i < rounds; i++) {
		select(left, right, output, 256);
		checksum += output[i % 256];
	}
	return { checksum, operations: rounds * 256 };
}
runRuntimeGapCase("number-predicate-storage", run);
