import { runRuntimeGapCase } from "../case-runner.mjs";

const inputs = [-234.375, -12.5, 0, 0.125, 3.75, 17.125, 125.5, 1024.875];

function run(scale) {
	const operations = 1500 * scale;
	let checksum = 0;
	for (let round = 0; round < operations; round++) {
		const value = inputs[round & 7] + (round & 15);
		const fixed = value.toFixed(3);
		const precision = value.toPrecision(7);
		const radix = value.toString(16);
		if (
			Number.parseFloat(fixed) !== value ||
			Number.parseFloat(precision) !== value ||
			radix.length === 0
		)
			throw new Error("number format mismatch");
		const text = fixed + ":" + precision + ":" + radix;
		for (let index = 0; index < text.length; index++)
			checksum += text.charCodeAt(index) * (index + 1);
	}
	return { checksum: checksum % 1000000007, operations };
}

runRuntimeGapCase("primordial-number-format", run);
