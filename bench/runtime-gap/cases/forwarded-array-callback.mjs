import { runRuntimeGapCase } from "../case-runner.mjs";

function traverse(values, callbacks, rounds) {
	for (let round = 0; round < rounds; round++) values.forEach(callbacks[round & 1]);
}

function run(scale) {
	const values = Array.from({ length: 256 }, (_, index) => index * 0.25);
	let total = 0;
	const factor = 1.25;
	const callbacks = [
		function first(value, index) {
			total += value * factor + index;
		},
		function second(value, index) {
			total += value * (factor + 0.5) - index;
		},
	];
	const rounds = 1000 * scale;
	traverse(values, callbacks, rounds);
	return { checksum: total, operations: rounds * values.length };
}

runRuntimeGapCase("forwarded-array-callback", run);
