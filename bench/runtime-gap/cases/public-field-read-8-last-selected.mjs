import { runRuntimeGapCase } from "../case-runner.mjs";

const seed = Number(process.argv[2] ?? "1") & 255;

class Reader {
	value0;
	value1;
	value2;
	value3;
	value4;
	value5;
	value6;
	value7;
	constructor(value) {
		this.value0 = (value + 0) & 255;
		this.value1 = (value + 1) & 255;
		this.value2 = (value + 2) & 255;
		this.value3 = (value + 3) & 255;
		this.value4 = (value + 4) & 255;
		this.value5 = (value + 5) & 255;
		this.value6 = (value + 6) & 255;
		this.value7 = (value + 7) & 255;
	}
	read() {
		return this.value7;
	}
}

const readers = Array.from({ length: 32 }, (_, index) => new Reader(seed + index));
const reader = readers[seed & 31];

function run(scale) {
	let checksum = 0;
	const operations = 1_000_000 * scale;
	for (let index = 0; index < operations; index++) {
		checksum = (checksum + readers[index & 31].read()) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}

runRuntimeGapCase("public-field-read-8-last-selected", run);
