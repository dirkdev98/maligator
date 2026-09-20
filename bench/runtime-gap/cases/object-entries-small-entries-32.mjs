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
	p8: (seed + 8) & 255,
	p9: (seed + 9) & 255,
	p10: (seed + 10) & 255,
	p11: (seed + 11) & 255,
	p12: (seed + 12) & 255,
	p13: (seed + 13) & 255,
	p14: (seed + 14) & 255,
	p15: (seed + 15) & 255,
	p16: (seed + 16) & 255,
	p17: (seed + 17) & 255,
	p18: (seed + 18) & 255,
	p19: (seed + 19) & 255,
	p20: (seed + 20) & 255,
	p21: (seed + 21) & 255,
	p22: (seed + 22) & 255,
	p23: (seed + 23) & 255,
	p24: (seed + 24) & 255,
	p25: (seed + 25) & 255,
	p26: (seed + 26) & 255,
	p27: (seed + 27) & 255,
	p28: (seed + 28) & 255,
	p29: (seed + 29) & 255,
	p30: (seed + 30) & 255,
	p31: (seed + 31) & 255,
}));
const retained = new Array(256);

function run(scale) {
	let checksum = 0;
	const operations = 20_000 * scale;
	for (let index = 0; index < operations; index++) {
		const result = Object.entries(records[index & 31]);
		retained[index & 255] = result;
		checksum = (checksum + result.length) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}

function verify() {
	for (const result of retained) {
		if (!Array.isArray(result) || result.length !== 32) {
			throw new Error("object enumeration differs");
		}
	}
}

runRuntimeGapCase("object-entries-small-entries-32", run, verify);
