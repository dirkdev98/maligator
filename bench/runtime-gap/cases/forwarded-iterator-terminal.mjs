import { runRuntimeGapCase } from "../case-runner.mjs";
function reduce(values, callbacks, pick) {
	return values.values().reduce(callbacks[pick], 0);
}
function run(scale) {
	const values = new Int32Array(256);
	for (let index = 0; index < values.length; index++) values[index] = index;
	const factor = 3;
	const callbacks = [
		function first(acc, value, index) {
			return acc + value * factor + index;
		},
		function second(acc, value, index) {
			return acc + value * (factor + 1) - index;
		},
	];
	const rounds = 500 * scale;
	let checksum = 0;
	for (let round = 0; round < rounds; round++)
		checksum += reduce(values, callbacks, round & 1);
	return { checksum, operations: rounds * values.length };
}
runRuntimeGapCase("forwarded-iterator-terminal", run);
