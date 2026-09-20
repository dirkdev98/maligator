import { runRuntimeGapCase } from "../case-runner.mjs";

const seed = Number(process.argv[2] ?? "1") & 255;

class Reader {
	offset;
	constructor(offset) {
		this.offset = offset;
	}
	read(value) {
		return (value + this.offset) & 255;
	}
}

const readers = Array.from({ length: 32 }, (_, index) => new Reader(seed + index));

function run(scale) {
	let checksum = 0;
	const operations = 1_000_000 * scale;
	for (let index = 0; index < operations; index++) {
		checksum = (checksum + readers[index & 31].read(index & 255)) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}

function verify() {}

runRuntimeGapCase("method-name-unique", run, verify);
