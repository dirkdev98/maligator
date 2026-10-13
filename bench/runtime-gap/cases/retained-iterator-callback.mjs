import { runRuntimeGapCase } from "../case-runner.mjs";
function make(values, callbacks, pick) {
	return values.values().map(callbacks[pick]);
}
function run(scale) {
	const values = new Int32Array(128);
	for (let index = 0; index < values.length; index++) values[index] = index;
	const factor = 3;
	const callbacks = [
		function first(value, index) {
			return value * factor + index;
		},
		function second(value, index) {
			return value * (factor + 1) - index;
		},
	];
	const rounds = 500 * scale;
	let checksum = 0;
	for (let round = 0; round < rounds; round++) {
		const helper = make(values, callbacks, round & 1);
		checksum += helper.next().value;
		for (const value of helper) checksum += value;
	}
	return { checksum, operations: rounds * values.length };
}
runRuntimeGapCase("retained-iterator-callback", run);
