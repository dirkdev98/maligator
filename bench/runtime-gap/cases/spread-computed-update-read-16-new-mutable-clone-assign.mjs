import { runRuntimeGapCase } from "../case-runner.mjs";

const seed = Number(process.argv[2] ?? "1") & 255;
const key = "extra";
const source = {
	p0: (seed + 0) & 255,
	p1: (seed + 1) & 255,
	p2: (seed + 2) & 255,
	p3: (seed + 3) & 255,
	p4: (seed + 4) & 255,
	p5: (seed + 5) & 255,
	p6: (seed + 6) & 255,
	p7: (seed + 7) & 255,
	p8: (seed + 8) & 255,
	p9: (seed + 9) & 255,
	p10: (seed + 10) & 255,
	p11: (seed + 11) & 255,
	p12: (seed + 12) & 255,
	p13: (seed + 13) & 255,
	p14: (seed + 14) & 255,
	p15: (seed + 15) & 255,
};

function create(replacement) {
	const copy = { ...source };
	copy[key] = replacement;
	return copy;
}

const copies = Array.from({ length: 32 }, (_, index) => create((seed + index) & 255));

function run(scale) {
	let checksum = 0;
	const operations = 500_000 * scale;
	for (let index = 0; index < operations; index++) {
		checksum = (checksum + copies[index & 31][key]) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}

runRuntimeGapCase("spread-computed-update-read-16-new-mutable-clone-assign", run);
