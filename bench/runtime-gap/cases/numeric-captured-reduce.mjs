import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const values = Array.from({ length: 256 }, (_, index) => index & 31);
	let checksum = 0;
	const rounds = 800 * scale;
	for (let round = 0; round < rounds; round++) {
		const factor = (round & 3) + 1;
		const reducer = function (accumulator, value, index) {
			for (let repeat = 0; repeat < 2; repeat++) accumulator += value * factor;
			return accumulator + index;
		};
		checksum =
			(checksum + values.reduce(reducer, 0) + values.reduceRight(reducer, 0)) %
			1000000007;
	}
	return { checksum, operations: rounds * values.length * 2 };
}

runRuntimeGapCase("numeric-captured-reduce", run);
