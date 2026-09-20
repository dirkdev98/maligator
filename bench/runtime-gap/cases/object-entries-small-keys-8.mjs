import { runRuntimeGapCase } from "../case-runner.mjs";

const seed = Number(process.argv[2] ?? "1") & 255;
const records = Array.from({ length: 32 }, () => ({
	p0: (seed + 0) & 255,
	p1: (seed + 1) & 255,
	p2: (seed + 2) & 255,
	p3: (seed + 3) & 255,
	p4: (seed + 4) & 255,
	p5: (seed + 5) & 255,
	p6: (seed + 6) & 255,
	p7: (seed + 7) & 255,
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
		if (!Array.isArray(result) || result.length !== 8) {
			throw new Error("object enumeration differs");
		}
	}
}

runRuntimeGapCase("object-entries-small-keys-8", run, verify);
