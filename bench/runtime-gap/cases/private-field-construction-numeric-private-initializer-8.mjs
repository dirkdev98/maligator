import { runRuntimeGapCase } from "../case-runner.mjs";

const seed = Number(process.argv[2] ?? "1") & 255;

class Record {
	#value0 = (seed + 0) & 255;
	#value1 = (seed + 1) & 255;
	#value2 = (seed + 2) & 255;
	#value3 = (seed + 3) & 255;
	#value4 = (seed + 4) & 255;
	#value5 = (seed + 5) & 255;
	#value6 = (seed + 6) & 255;
	#value7 = (seed + 7) & 255;
	input;
	constructor(input) {
		this.input = input;
	}
	sample() {
		return this.#value7;
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
		if (!(record instanceof Record) || (record.sample() !== seed + 7) & 255) {
			throw new Error("constructed field state differs");
		}
	}
}

runRuntimeGapCase(
	"private-field-construction-numeric-private-initializer-8",
	run,
	verify,
);
