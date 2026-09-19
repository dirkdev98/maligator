import { runRuntimeGapCase } from "../case-runner.mjs";

const seed = Number(process.argv[2] ?? "1") & 255;
const arrays = Array.from({ length: 32 }, () => [seed, -0, 0, seed + 1]);
const needles = [-0, 0];

function run(scale) {
	let checksum = 0;
	const operations = 1_000_000 * scale;
	for (let index = 0; index < operations; index++) {
		checksum += arrays[(index >>> 8) & 31].includes(needles[index & 1]) ? 1 : 0;
	}
	return { checksum: checksum >>> 0, operations };
}

runRuntimeGapCase("array-includes-signed-zero", run);
