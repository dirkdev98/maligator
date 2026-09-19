import { runRuntimeGapCase } from "../case-runner.mjs";

const seed = Number(process.argv[2] ?? "1") & 255;

class Reader {
	#value0;
	#value1;
	#value2;
	#value3;
	#value4;
	#value5;
	#value6;
	#value7;
	#value8;
	#value9;
	#value10;
	#value11;
	#value12;
	#value13;
	#value14;
	#value15;
	#value16;
	#value17;
	#value18;
	#value19;
	#value20;
	#value21;
	#value22;
	#value23;
	#value24;
	#value25;
	#value26;
	#value27;
	#value28;
	#value29;
	#value30;
	#value31;
	constructor(value) {
		this.#value0 = (value + 0) & 255;
		this.#value1 = (value + 1) & 255;
		this.#value2 = (value + 2) & 255;
		this.#value3 = (value + 3) & 255;
		this.#value4 = (value + 4) & 255;
		this.#value5 = (value + 5) & 255;
		this.#value6 = (value + 6) & 255;
		this.#value7 = (value + 7) & 255;
		this.#value8 = (value + 8) & 255;
		this.#value9 = (value + 9) & 255;
		this.#value10 = (value + 10) & 255;
		this.#value11 = (value + 11) & 255;
		this.#value12 = (value + 12) & 255;
		this.#value13 = (value + 13) & 255;
		this.#value14 = (value + 14) & 255;
		this.#value15 = (value + 15) & 255;
		this.#value16 = (value + 16) & 255;
		this.#value17 = (value + 17) & 255;
		this.#value18 = (value + 18) & 255;
		this.#value19 = (value + 19) & 255;
		this.#value20 = (value + 20) & 255;
		this.#value21 = (value + 21) & 255;
		this.#value22 = (value + 22) & 255;
		this.#value23 = (value + 23) & 255;
		this.#value24 = (value + 24) & 255;
		this.#value25 = (value + 25) & 255;
		this.#value26 = (value + 26) & 255;
		this.#value27 = (value + 27) & 255;
		this.#value28 = (value + 28) & 255;
		this.#value29 = (value + 29) & 255;
		this.#value30 = (value + 30) & 255;
		this.#value31 = (value + 31) & 255;
	}
	read() {
		return this.#value0;
	}
}

const readers = Array.from({ length: 32 }, (_, index) => new Reader(seed + index));
const reader = readers[seed & 31];

function run(scale) {
	let checksum = 0;
	const operations = 1_000_000 * scale;
	for (let index = 0; index < operations; index++) {
		checksum = (checksum + reader.read()) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}

runRuntimeGapCase("private-field-read-32-first-known", run);
