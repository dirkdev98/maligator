import { runAsyncRuntimeGapCase } from "../async-case-runner.mjs";
async function run(scale) {
	const source = Array.from({ length: 64 }, (_, index) => index);
	const factor = 3;
	function mapper(value, index) {
		return value * factor + index;
	}
	const rounds = 100 * scale;
	let checksum = 0;
	for (let round = 0; round < rounds; round++) {
		const result = await Array.fromAsync(source, mapper);
		checksum += result[round & 63] + result.length;
	}
	return { checksum, operations: rounds * source.length };
}
await runAsyncRuntimeGapCase("array-from-async-captured-map", run);
