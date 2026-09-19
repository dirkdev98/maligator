import { runRuntimeGapCase } from "../case-runner.mjs";

const seed = Number(process.argv[2] ?? "1") & 255;
const keys = Array.from({ length: 4_096 }, (_, index) => seed * 16_384 + index);
const misses = Array.from({ length: 4_096 }, (_, index) => (seed + 1) * 16_384 + index);
const entries = keys.map((key, index) => [key, (index + seed) & 255]);
const maps = [new Map(entries), new Map(entries)];
const lookupKeys = keys;

function run(scale) {
	let checksum = 0;
	const operations = 500_000 * scale;
	for (let index = 0; index < operations; index++) {
		const value = maps[(index >>> 8) & 1].get(lookupKeys[index & 4_095]);
		checksum = (checksum + (value === undefined ? 1 : value)) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}

runRuntimeGapCase("map-get-hit-4096-selected-int-key", run);
