import { runRuntimeGapCase } from "../case-runner.mjs";

const seed = Number(process.argv[2] ?? "1") & 255;
const arrays = Array.from(
	{ length: 32 },
	(_, arrayIndex) =>
		new Int32Array(Array.from({ length: 8 }, (_, index) => seed + arrayIndex + index)),
);
const array = arrays[seed & 31];

function run(scale) {
	let checksum = 0;
	const operations = 1_000_000 * scale;
	for (let index = 0; index < operations; index++) {
		const value = array.at(-1);
		checksum = (checksum + value) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}

runRuntimeGapCase("typed-array-at-negative-known", run);
