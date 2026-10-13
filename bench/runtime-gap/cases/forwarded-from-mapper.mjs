import { runRuntimeGapCase } from "../case-runner.mjs";
function mapFrom(constructor, source, callbacks, pick) {
	return constructor.from(source, callbacks[pick]);
}
function run(scale) {
	const source = new Float64Array(128);
	for (let index = 0; index < source.length; index++) source[index] = index / 4;
	const factor = 3;
	const callbacks = [
		function first(value, index) {
			return value * factor + (index & 1);
		},
		function second(value, index) {
			return value * (factor + 1) - (index & 1);
		},
	];
	const rounds = 500 * scale;
	let checksum = 0;
	for (let round = 0; round < rounds; round++) {
		const output = mapFrom(
			round & 1 ? Float64Array : Array,
			source,
			callbacks,
			round & 1,
		);
		checksum += output[1] + output[127];
	}
	return { checksum, operations: rounds * source.length };
}
runRuntimeGapCase("forwarded-from-mapper", run);
