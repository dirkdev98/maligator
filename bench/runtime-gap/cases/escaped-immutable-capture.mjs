import { runRuntimeGapCase } from "../case-runner.mjs";

function make(seed) {
	const bias = seed & 255;
	const factor = (seed & 7) + 1;
	return function read(input) {
		let sum = 0;
		for (let step = 0; step < 16; step++) {
			sum += ((input + bias + step) * factor) & 255;
		}
		return sum;
	};
}

function run(scale) {
	const readers = [make(scale), make(scale + 1)];
	globalThis.retainedImmutableReaders = readers;
	let checksum = 0;
	const operations = 100_000 * scale;
	for (let index = 0; index < operations; index++) {
		const read = readers[index & 1];
		checksum = (checksum + read(index & 15)) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}

runRuntimeGapCase("escaped-immutable-capture", run);
