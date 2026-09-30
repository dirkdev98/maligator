import { runAsyncRuntimeGapCase } from "../async-case-runner.mjs";

async function run(scale) {
	const operations = 4000 * scale;
	let checksum = 0;
	for (let i = 0; i < operations; i++) {
		const values = await Promise.all(
			Array.from({ length: 8 }, (_, j) => Promise.resolve((i + j) & 1023)),
		);
		checksum += values[i & 7] + values.length;
	}
	return { checksum: checksum % 1000000007, operations };
}

runAsyncRuntimeGapCase("promise-all-eight", run);
