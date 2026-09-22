import { runRuntimeGapCase } from "../case-runner.mjs";

const seed = Number(process.argv[2] ?? "1") & 255;
const left = Array.from(
	{ length: 32 },
	(_, index) => `left:${String(seed + index).padStart(11, "0")}`,
);
const right = Array.from(
	{ length: 32 },
	(_, index) => `right:${String(seed + index).padStart(10, "0")}`,
);

function run(scale) {
	let checksum = 0;
	const operations = 50_000 * scale;
	for (let index = 0; index < operations; index++) {
		const value = left[index & 31] + right[index & 31];
		for (let offset = 0; offset < value.length; offset++) {
			checksum = (checksum + value.charCodeAt(offset)) | 0;
		}
	}
	return { checksum: checksum >>> 0, operations };
}

runRuntimeGapCase("string-cons-full-scan-32", run);
