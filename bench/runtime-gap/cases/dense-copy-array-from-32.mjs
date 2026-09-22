import { runRuntimeGapCase } from "../case-runner.mjs";

const seed = Number(process.argv[2] ?? "1") & 255;
const sources = Array.from({ length: 32 }, (_, offset) =>
	Array.from({ length: 32 }, (_, index) => (seed + offset + index) & 255),
);
const retained = new Array(256);

function run(scale) {
	let checksum = 0;
	const operations = 100_000 * scale;
	for (let index = 0; index < operations; index++) {
		const source = sources[index & 31];
		const copy = Array.from(source);
		retained[index & 255] = copy;
		checksum = (checksum + copy[0] + copy[31]) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}

function verify() {
	for (const copy of retained) {
		if (!Array.isArray(copy) || copy.length !== 32 || copy[31] === undefined) {
			throw new Error("dense copy differs");
		}
	}
}

runRuntimeGapCase("dense-copy-array-from-32", run, verify);
