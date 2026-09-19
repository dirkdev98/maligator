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
		const [left, right] = pairs[index & 1_023];
		checksum = (checksum + left + right) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}

runRuntimeGapCase("pair-destructure", run);
