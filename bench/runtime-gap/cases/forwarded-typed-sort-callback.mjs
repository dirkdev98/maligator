import { runRuntimeGapCase } from "../case-runner.mjs";

function sort(values, callbacks, index) {
	return values.toSorted(callbacks[index]);
}
function run(scale) {
	const values = Float64Array.from({ length: 128 }, (_, i) => ((i * 37) % 131) * 0.25);
	const factor = 1.25;
	const callbacks = [
		function ascending(a, b) {
			return (a - b) * factor;
		},
		function descending(a, b) {
			return (b - a) * factor;
		},
	];
	let checksum = 0;
	const rounds = 500 * scale;
	for (let round = 0; round < rounds; round++) {
		const output = sort(values, callbacks, round & 1);
		checksum += output[0] + output[63] + output[127];
	}
	return { checksum, operations: rounds * values.length };
}
runRuntimeGapCase("forwarded-typed-sort-callback", run);
