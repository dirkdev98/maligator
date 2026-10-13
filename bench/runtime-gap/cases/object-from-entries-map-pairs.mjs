import { runRuntimeGapCase } from "../case-runner.mjs";

const seed = Number(process.argv[2] ?? "1") & 255;
const source = new Map();
for (let index = 0; index < 8; index++) source.set("p" + index, seed + index);
const retained = new Array(128);
function run(scale) {
	let checksum = 0;
	const operations = 20_000 * scale;
	for (let index = 0; index < operations; index++) {
		const result = Object.fromEntries(source);
		retained[index & 127] = result;
		checksum = (checksum + result.p0 + result.p7) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}
function verify() {
	for (const result of retained) {
		if (result.p0 !== seed || result.p7 !== seed + 7 || Object.keys(result).length !== 8)
			throw new Error("fromEntries Map result differs");
	}
}
runRuntimeGapCase("object-from-entries-map-pairs", run, verify);
