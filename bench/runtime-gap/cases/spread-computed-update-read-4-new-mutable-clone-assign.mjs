import { runRuntimeGapCase } from "../case-runner.mjs";

const seed = Number(process.argv[2] ?? "1") & 255;
const key = "extra";
const source = {
	p0: (seed + 0) & 255,
	p1: (seed + 1) & 255,
	p2: (seed + 2) & 255,
	p3: (seed + 3) & 255,
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

runRuntimeGapCase("spread-computed-update-read-4-new-mutable-clone-assign", run);
