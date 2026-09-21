import { runRuntimeGapCase } from "../case-runner.mjs";

const seed = Number(process.argv[2] ?? "1") & 255;

class Empty {}

const retained = new Array(256);

function run(scale) {
	let checksum = 0;
	const operations = 100_000 * scale;
	for (let index = 0; index < operations; index++) {
		retained[index & 255] = new Empty();
		checksum = (checksum + ((index + seed) & 1)) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}

function verify() {
	for (const value of retained) {
		if (!(value instanceof Empty)) throw new Error("empty receiver was not retained");
	}
}

runRuntimeGapCase("constructor-base-empty-retained", run, verify);
