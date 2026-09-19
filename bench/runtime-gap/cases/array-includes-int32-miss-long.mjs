import { runRuntimeGapCase } from "../case-runner.mjs";

const seed = Number(process.argv[2] ?? "1") & 255;
const arrays = Array.from({ length: 32 }, (_, arrayIndex) =>
	Array.from({ length: 2_048 }, (_, index) => (seed + arrayIndex + index) & 2_047),
);
const misses = Array.from({ length: 2_048 }, (_, index) => -(index + 1));

function run(scale) {
	let checksum = 0;
	const operations = 200_000 * scale;
	for (let index = 0; index < operations; index++) {
		checksum += arrays[(index >>> 8) & 31].includes(misses[index & 2_047]) ? 1 : 0;
	}
	return { checksum: checksum >>> 0, operations };
}

runRuntimeGapCase("array-includes-int32-miss-long", run);
