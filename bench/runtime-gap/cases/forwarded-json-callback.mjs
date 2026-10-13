import { runRuntimeGapCase } from "../case-runner.mjs";
function parse(text, callbacks, pick) {
	return JSON.parse(text, callbacks[pick]);
}
function stringify(value, callbacks, pick) {
	return JSON.stringify(value, callbacks[pick]);
}
function run(scale) {
	const values = [];
	for (let index = 0; index < 64; index++) values.push({ x: index, y: index + 1 });
	const text = JSON.stringify(values),
		factor = 2;
	const callbacks = [
		function first(key, value) {
			return typeof value === "number" ? value * factor : value;
		},
		function second(key, value) {
			return typeof value === "number" ? value + factor : value;
		},
	];
	const rounds = 200 * scale;
	let checksum = 0;
	for (let round = 0; round < rounds; round++) {
		const parsed = parse(text, callbacks, round & 1);
		const output = stringify(parsed, callbacks, (round + 1) & 1);
		checksum += output.length + parsed[63].x;
	}
	return { checksum, operations: rounds * 2 * (1 + values.length * 3) };
}
runRuntimeGapCase("forwarded-json-callback", run);
