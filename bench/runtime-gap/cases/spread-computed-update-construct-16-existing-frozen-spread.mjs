import { runRuntimeGapCase } from "../case-runner.mjs";

const seed = Number(process.argv[2] ?? "1") & 255;
const key = "p15";
const source = Object.freeze({
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
});

function create(replacement) {
	return { ...source, [key]: replacement };
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
	"spread-computed-update-construct-16-existing-frozen-spread",
	run,
	verify,
);
