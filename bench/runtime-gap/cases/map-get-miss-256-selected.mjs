import { runRuntimeGapCase } from "../case-runner.mjs";

const seed = Number(process.argv[2] ?? "1") & 255;
const keys = Array.from({ length: 256 }, (_, index) => ({ index, seed }));
const misses = Array.from({ length: 256 }, (_, index) => ({ index, seed: seed + 1 }));
const entries = keys.map((key, index) => [key, (index + seed) & 255]);
const collections = [new Map(entries), new Map(entries)];
const collection = collections[seed & 1];
const lookupKeys = misses;
const mask = 255;

function run(scale) {
	let checksum = 0;
	const operations = 500_000 * scale;
	for (let index = 0; index < operations; index++) {
		const value = collections[(index >>> 8) & 1].get(lookupKeys[index & mask]);
		checksum = (checksum + (value === undefined ? 1 : value)) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}

runRuntimeGapCase("map-get-miss-256-selected", run);
