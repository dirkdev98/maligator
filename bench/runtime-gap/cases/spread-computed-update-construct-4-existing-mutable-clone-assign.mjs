import { runRuntimeGapCase } from "../case-runner.mjs";

const seed = Number(process.argv[2] ?? "1") & 255;
const key = "p3";
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

const retained = new Array(256);

function run(scale) {
	let checksum = 0;
	const operations = 20_000 * scale;
	for (let index = 0; index < operations; index++) {
		const replacement = (seed + index) & 255;
		retained[index & 255] = create(replacement);
		checksum = (checksum + replacement) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}

function verify() {
	for (const copy of retained) {
		if (copy === undefined || copy[key] === undefined) {
			throw new Error("computed update was not retained");
		}
	}
}

runRuntimeGapCase(
	"spread-computed-update-construct-4-existing-mutable-clone-assign",
	run,
	verify,
);
