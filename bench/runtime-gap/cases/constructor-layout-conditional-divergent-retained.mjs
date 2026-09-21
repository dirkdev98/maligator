import { runRuntimeGapCase } from "../case-runner.mjs";

const seed = Number(process.argv[2] ?? "1") & 255;

class Record {
	constructor(value) {
		this.left = value;
		if (value & 1) this.right = (value + 1) & 255;
	}
}

const retained = new Array(256);

function run(scale) {
	let checksum = 0;
	const operations = 50_000 * scale;
	for (let index = 0; index < operations; index++) {
		const record = new Record((seed + index) & 255);
		retained[index & 255] = record;
		checksum = (checksum + record.left + (record.right ?? 0)) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}

function verify() {
	for (let index = 0; index < retained.length; index++) {
		const record = retained[index];
		if (!(record instanceof Record) || record.left === undefined) {
			throw new Error("constructor layout result differs");
		}
	}
}

runRuntimeGapCase("constructor-layout-conditional-divergent-retained", run, verify);
