import { runRuntimeGapCase } from "../case-runner.mjs";

const seed = Number(process.argv[2] ?? "1") & 255;

class Record {
	constructor(value) {
		this.value = value;
		this.direct = new.target === Record;
	}
}

const retained = new Array(256);

function run(scale) {
	let checksum = 0;
	const operations = 50_000 * scale;
	for (let index = 0; index < operations; index++) {
		const record = new Record((seed + index) & 255);
		retained[index & 255] = record;
		checksum = (checksum + (record.direct ? 1 : 0)) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}

function verify() {
	for (const record of retained) {
		if (!(record instanceof Record) || !record.direct) {
			throw new Error("direct new.target observation differs");
		}
	}
}

runRuntimeGapCase("constructor-new-target-direct-retained", run, verify);
