import { runRuntimeGapCase } from "../case-runner.mjs";

const seed = Number(process.argv[2] ?? "1") & 255;

class Record {
	input;
	constructor(input) {
		this.value0 = (seed + 0) & 255;
		this.value1 = (seed + 1) & 255;
		this.value2 = (seed + 2) & 255;
		this.value3 = (seed + 3) & 255;
		this.value4 = (seed + 4) & 255;
		this.value5 = (seed + 5) & 255;
		this.value6 = (seed + 6) & 255;
		this.value7 = (seed + 7) & 255;
		this.value8 = (seed + 8) & 255;
		this.value9 = (seed + 9) & 255;
		this.value10 = (seed + 10) & 255;
		this.value11 = (seed + 11) & 255;
		this.value12 = (seed + 12) & 255;
		this.value13 = (seed + 13) & 255;
		this.value14 = (seed + 14) & 255;
		this.value15 = (seed + 15) & 255;
		this.value16 = (seed + 16) & 255;
		this.value17 = (seed + 17) & 255;
		this.value18 = (seed + 18) & 255;
		this.value19 = (seed + 19) & 255;
		this.value20 = (seed + 20) & 255;
		this.value21 = (seed + 21) & 255;
		this.value22 = (seed + 22) & 255;
		this.value23 = (seed + 23) & 255;
		this.value24 = (seed + 24) & 255;
		this.value25 = (seed + 25) & 255;
		this.value26 = (seed + 26) & 255;
		this.value27 = (seed + 27) & 255;
		this.value28 = (seed + 28) & 255;
		this.value29 = (seed + 29) & 255;
		this.value30 = (seed + 30) & 255;
		this.value31 = (seed + 31) & 255;
		this.input = input;
	}
	sample() {
		return this.value31;
	}
}

const retained = new Array(256);

function run(scale) {
	const operations = 50_000 * scale;
	for (let index = 0; index < operations; index++) {
		retained[index & 255] = new Record((seed + index) & 255);
	}
	return { checksum: (operations + seed) >>> 0, operations };
}

function verify() {
	for (const record of retained) {
		if (!(record instanceof Record) || (record.sample() !== seed + 31) & 255) {
			throw new Error("constructed field state differs");
		}
	}
}

runRuntimeGapCase("private-field-construction-numeric-public-assignment-32", run, verify);
