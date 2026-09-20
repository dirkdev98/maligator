import { runRuntimeGapCase } from "../case-runner.mjs";

const seed = Number(process.argv[2] ?? "1") & 255;
const records = Array.from({ length: 32 }, () => ({
	p0: (seed + 0) & 255,
	p1: (seed + 1) & 255,
}));
const retained = new Array(256);

function run(scale) {
	let checksum = 0;
	const operations = 20_000 * scale;
	for (let index = 0; index < operations; index++) {
		const result = Object.keys(records[index & 31]);
		retained[index & 255] = result;
		checksum = (checksum + result.length) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}

function verify() {
	for (const result of retained) {
		if (!Array.isArray(result) || result.length !== 2) {
			throw new Error("object enumeration differs");
		}
	}
}

runRuntimeGapCase("object-entries-small-keys-2", run, verify);
