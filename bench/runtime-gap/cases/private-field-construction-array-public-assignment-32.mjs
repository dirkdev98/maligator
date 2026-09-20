import { runRuntimeGapCase } from "../case-runner.mjs";

const seed = Number(process.argv[2] ?? "1") & 255;

class Record {
	input;
	constructor(input) {
		this.value0 = [];
		this.value1 = [];
		this.value2 = [];
		this.value3 = [];
		this.value4 = [];
		this.value5 = [];
		this.value6 = [];
		this.value7 = [];
		this.value8 = [];
		this.value9 = [];
		this.value10 = [];
		this.value11 = [];
		this.value12 = [];
		this.value13 = [];
		this.value14 = [];
		this.value15 = [];
		this.value16 = [];
		this.value17 = [];
		this.value18 = [];
		this.value19 = [];
		this.value20 = [];
		this.value21 = [];
		this.value22 = [];
		this.value23 = [];
		this.value24 = [];
		this.value25 = [];
		this.value26 = [];
		this.value27 = [];
		this.value28 = [];
		this.value29 = [];
		this.value30 = [];
		this.value31 = [];
		this.input = input;
	}
	sample() {
		return this.value31.length;
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
		if (!(record instanceof Record) || record.sample() !== 0) {
			throw new Error("constructed field state differs");
		}
	}
}

runRuntimeGapCase("private-field-construction-array-public-assignment-32", run, verify);
