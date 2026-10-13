import { runRuntimeGapCase } from "../case-runner.mjs";

function sortedBatch(values, direction) {
	return values.toSorted(function compareBigInt(left, right) {
		return (left < right ? -1 : left > right ? 1 : 0) * direction;
	});
}

function run(scale) {
	const input = new BigInt64Array(128);
	for (let index = 0; index < input.length; index++)
		input[index] = BigInt((index * 71) % 128);
	const rounds = 400 * scale;
	let checksum = 0;
	for (let round = 0; round < rounds; round++) {
		const output = sortedBatch(input, round & 1 ? -1 : 1);
		checksum += Number(output[round % output.length]);
	}
	return { checksum, operations: rounds * input.length };
}

runRuntimeGapCase("typed-array-bigint-sort-callback", run);
