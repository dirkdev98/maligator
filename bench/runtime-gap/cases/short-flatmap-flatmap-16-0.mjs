import { runRuntimeGapCase } from "../case-runner.mjs";

const seed = Number(process.argv[2] ?? "1") & 255;
const preparedRows = Array.from({ length: 16 }, (_, row) => ({
	values: Array.from({ length: 0 }, (_, column) => (seed + row + column) & 255),
}));
const retained = new Array(256);

function run(scale) {
	let checksum = 0;
	const operations = 10_000 * scale;
	for (let index = 0; index < operations; index++) {
		const result = preparedRows.flatMap((row) => row.values);
		retained[index & 255] = result;
		checksum = (checksum + result.length) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}

function verify() {
	for (const result of retained) {
		if (!Array.isArray(result) || result.length !== 0) {
			throw new Error("flatMap result differs");
		}
	}
}

runRuntimeGapCase("short-flatmap-flatmap-16-0", run, verify);
