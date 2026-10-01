import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const values = Array.from({ length: 32 }, (_, index) => index);
	const operations = 1200 * scale;
	let checksum = 0;
	for (let round = 0; round < operations; round++) {
		const marker = round & 255;
		values.fill(marker, 4, 12);
		values.copyWithin(8, 0, 16);
		const offset = round & 7;
		const window = values.slice(offset, offset + 16);
		if (window.length !== 16 || values[12] !== marker || values[19] !== marker)
			throw new Error("array copy mismatch");
		for (let index = 0; index < values.length; index++) checksum += values[index];
		for (let index = 0; index < window.length; index++)
			checksum += window[index] * (index + 1);
	}
	return { checksum: checksum % 1000000007, operations };
}

runRuntimeGapCase("primordial-array-copy-fill", run);
