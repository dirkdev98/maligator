import { runRuntimeGapCase } from "../case-runner.mjs";

const seed = Number(process.argv[2] ?? "1") & 255;
const pairs = Array.from({ length: 1_024 }, (_, index) => [
	index & 255,
	(index + seed) & 255,
]);

function run(scale) {
	let checksum = 0;
	const operations = 1_000_000 * scale;
	for (let index = 0; index < operations; index++) {
		const pair = pairs[index & 1_023];
		const left = pair[0];
		const right = pair[1];
		checksum = (checksum + left + right) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}

runRuntimeGapCase("pair-indexed-control", run);
