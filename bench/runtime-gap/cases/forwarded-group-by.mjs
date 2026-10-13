import { runRuntimeGapCase } from "../case-runner.mjs";
function group(source, callbacks, pick) {
	return Map.groupBy(source, callbacks[pick]);
}
function run(scale) {
	const values = new Int32Array(256);
	for (let index = 0; index < values.length; index++) values[index] = index;
	const factor = 3;
	const callbacks = [
		function first(value, index) {
			return (value * factor + index) & 7;
		},
		function second(value, index) {
			return (value * (factor + 1) + index) & 7;
		},
	];
	const rounds = 500 * scale;
	let checksum = 0;
	for (let round = 0; round < rounds; round++) {
		const groups = group(values, callbacks, round & 1);
		checksum += groups.size + groups.get(0).length + groups.get(0)[0];
	}
	return { checksum, operations: rounds * values.length };
}
runRuntimeGapCase("forwarded-group-by", run);
