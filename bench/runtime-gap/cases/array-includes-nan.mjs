import { runRuntimeGapCase } from "../case-runner.mjs";

const seed = Number(process.argv[2] ?? "1") & 255;
const nan = Number(process.argv[3] ?? "not-a-number");
const arrays = Array.from({ length: 32 }, (_, arrayIndex) => [seed + arrayIndex, nan]);

function run(scale) {
	let checksum = 0;
	const operations = 1_000_000 * scale;
	for (let index = 0; index < operations; index++) {
		checksum += arrays[(index >>> 8) & 31].includes(nan) ? 1 : 0;
	}
	return { checksum: checksum >>> 0, operations };
}

runRuntimeGapCase("array-includes-nan", run);
