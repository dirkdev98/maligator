import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const values = Array.from({ length: 32 }, (_, index) => index);
	const operations = 1000 * scale;
	let checksum = 0;
	for (let round = 0; round < operations; round++) {
		values[round & 31] = round & 255;
		let sum = 0;
		values.forEach((value, index) => {
			sum += value * (index + 1);
		});
		const left = values.reduce(
			(accumulator, value) => (accumulator * 3 + value) % 1000003,
			7,
		);
		const right = values.reduceRight(
			(accumulator, value) => (accumulator * 3 + value) % 1000003,
			7,
		);
		checksum = (checksum + sum + left * 3 + right * 5) % 1000000007;
	}
	return { checksum, operations };
}

runRuntimeGapCase("primordial-array-folds", run);
