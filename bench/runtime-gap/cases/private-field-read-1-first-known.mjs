import { runRuntimeGapCase } from "../case-runner.mjs";

const seed = Number(process.argv[2] ?? "1") & 255;

class Reader {
	#value0;
	constructor(value) {
		this.#value0 = (value + 0) & 255;
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

runRuntimeGapCase("private-field-read-1-first-known", run);
