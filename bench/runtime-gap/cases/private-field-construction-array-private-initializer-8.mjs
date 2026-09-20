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
	input;
	constructor(input) {
		this.input = input;
	}
	sample() {
		return this.#value7.length;
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

runRuntimeGapCase("private-field-construction-array-private-initializer-8", run, verify);
