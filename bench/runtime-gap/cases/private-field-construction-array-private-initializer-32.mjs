import { runRuntimeGapCase } from "../case-runner.mjs";

const seed = Number(process.argv[2] ?? "1") & 255;

class Record {
	#value0 = [];
	#value1 = [];
	#value2 = [];
	#value3 = [];
	#value4 = [];
	#value5 = [];
	#value6 = [];
	#value7 = [];
	#value8 = [];
	#value9 = [];
	#value10 = [];
	#value11 = [];
	#value12 = [];
	#value13 = [];
	#value14 = [];
	#value15 = [];
	#value16 = [];
	#value17 = [];
	#value18 = [];
	#value19 = [];
	#value20 = [];
	#value21 = [];
	#value22 = [];
	#value23 = [];
	#value24 = [];
	#value25 = [];
	#value26 = [];
	#value27 = [];
	#value28 = [];
	#value29 = [];
	#value30 = [];
	#value31 = [];
	input;
	constructor(input) {
		this.input = input;
	}
	sample() {
		return this.#value31.length;
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

runRuntimeGapCase("private-field-construction-array-private-initializer-32", run, verify);
