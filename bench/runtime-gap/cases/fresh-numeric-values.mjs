import { runRuntimeGapCase } from "../case-runner.mjs";

const retained = new Array(32);
function make(first, second) {
	first = +first;
	second = +second;
	return [first + 1, second * 2, first - second, first < second, first * second];
}
function run(scale) {
	let checksum = 0;
	const rounds = 40000 * scale;
	for (let i = 0; i < rounds; i++) {
		const result = make(i, i & 255);
		retained[i & 31] = result;
		checksum =
			(checksum + result[0] + result[1] - result[2] + (result[3] ? 1 : 0) + result[4]) |
			0;
	}
	for (let i = 0; i < 32; i++) checksum = (checksum + retained[i].length) | 0;
	return { checksum: checksum >>> 0, operations: rounds };
}
runRuntimeGapCase("fresh-numeric-values", run);
