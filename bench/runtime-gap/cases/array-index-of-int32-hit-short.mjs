import { runRuntimeGapCase } from "../case-runner.mjs";

const seed = Number(process.argv[2] ?? "1") & 255;
const arrays = Array.from({ length: 32 }, (_, arrayIndex) =>
	Array.from({ length: 8 }, (_, index) => seed + arrayIndex + index),
);

function run(scale) {
	let checksum = 0;
	const operations = 1_000_000 * scale;
	for (let index = 0; index < operations; index++) {
		const array = arrays[(index >>> 8) & 31];
		checksum = (checksum + array.indexOf(array[index & 7])) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}

runRuntimeGapCase("array-index-of-int32-hit-short", run);
