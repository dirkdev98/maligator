import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const forward = new Float64Array(256);
	const backward = new Int32Array(256);
	for (let index = 0; index < forward.length; index++) {
		forward[index] = (index & 31) + 0.5;
		backward[index] = (index & 31) - 16;
	}
	let checksum = 0;
	const rounds = 800 * scale;
	for (let round = 0; round < rounds; round++) {
		const factor = (round & 3) + 1;
		const reducer = function (accumulator, value) {
			return accumulator + value * factor + arguments[2] + arguments.length;
		};
		checksum =
			(checksum + forward.reduce(reducer, 0) + backward.reduceRight(reducer, 0)) %
			1000000007;
	}
	return { checksum, operations: rounds * forward.length * 2 };
}

runRuntimeGapCase("typed-numeric-reduce", run);
