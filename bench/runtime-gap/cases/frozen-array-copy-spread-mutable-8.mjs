import { runRuntimeGapCase } from "../case-runner.mjs";

const seed = Number(process.argv[2] ?? "1") & 255;
const source = Array.from({ length: 8 }, (_, index) => (seed + index) & 255);
const retained = new Array(256);

function run(scale) {
	let checksum = 0;
	const operations = 20_000 * scale;
	for (let index = 0; index < operations; index++) {
		const copy = [...source];
		retained[index & 255] = copy;
		checksum = (checksum + copy.length) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}

function verify() {
	for (const copy of retained) {
		if (!Array.isArray(copy) || copy.length !== source.length) {
			throw new Error("array copy differs");
		}
	}
}

runRuntimeGapCase("frozen-array-copy-spread-mutable-8", run, verify);
