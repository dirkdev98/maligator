import { runAsyncRuntimeGapCase } from "../async-case-runner.mjs";

async function run(scale) {
	const operations = 20000 * scale;
	let checksum = 0;
	for (let i = 0; i < operations; i++) checksum += await Promise.resolve(i & 1023);
	return { checksum: checksum % 1000000007, operations };
}

runAsyncRuntimeGapCase("promise-await-resolved", run);
