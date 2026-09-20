import { runRuntimeGapCase } from "../case-runner.mjs";

const seed = Number(process.argv[2] ?? "1") & 255;

class Record {
	value0 = (seed + 0) & 255;
	value1 = (seed + 1) & 255;
	value2 = (seed + 2) & 255;
	value3 = (seed + 3) & 255;
	value4 = (seed + 4) & 255;
	value5 = (seed + 5) & 255;
	value6 = (seed + 6) & 255;
	value7 = (seed + 7) & 255;
	value8 = (seed + 8) & 255;
	value9 = (seed + 9) & 255;
	value10 = (seed + 10) & 255;
	value11 = (seed + 11) & 255;
	value12 = (seed + 12) & 255;
	value13 = (seed + 13) & 255;
	value14 = (seed + 14) & 255;
	value15 = (seed + 15) & 255;
	value16 = (seed + 16) & 255;
	value17 = (seed + 17) & 255;
	value18 = (seed + 18) & 255;
	value19 = (seed + 19) & 255;
	value20 = (seed + 20) & 255;
	value21 = (seed + 21) & 255;
	value22 = (seed + 22) & 255;
	value23 = (seed + 23) & 255;
	value24 = (seed + 24) & 255;
	value25 = (seed + 25) & 255;
	value26 = (seed + 26) & 255;
	value27 = (seed + 27) & 255;
	value28 = (seed + 28) & 255;
	value29 = (seed + 29) & 255;
	value30 = (seed + 30) & 255;
	value31 = (seed + 31) & 255;
	input;
	constructor(input) {
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

runRuntimeGapCase(
	"private-field-construction-numeric-public-initializer-32",
	run,
	verify,
);
