import { runRuntimeGapCase } from "../case-runner.mjs";

const seed = Number(process.argv[2] ?? "1") & 255;

class Record {
	constructor(value) {
		this.value = value;
		return { value: (value + 1) & 255 };
	}
}

const retained = new Array(256);

function run(scale) {
	let checksum = 0;
	const operations = 50_000 * scale;
	for (let index = 0; index < operations; index++) {
		const value = (seed + index) & 255;
		const record = new Record(value);
		retained[index & 255] = record;
		checksum = (checksum + record.value) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}

function verify() {
	for (const record of retained) {
		if (record instanceof Record) {
			throw new Error("constructor return selection differs");
		}
	}
}

runRuntimeGapCase("constructor-return-object-retained", run, verify);
