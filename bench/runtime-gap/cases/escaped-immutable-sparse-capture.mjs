import { runRuntimeGapCase } from "../case-runner.mjs";

function make(seed) {
	const bias = seed & 255;
	const factor = (seed & 7) + 1;
	const extra0 = seed + 17;
	const extra1 = seed + 31;
	return {
		read: function read(input) {
			let sum = 0;
			for (let step = 0; step < 16; step++) {
				sum += ((input + bias + step) * factor) & 255;
			}
			return sum;
		},
		keep: () => extra0 + extra1,
	};
}

function run(scale) {
	const first = make(scale);
	const second = make(scale + 1);
	let checksum = (first.keep() + second.keep()) | 0;
	const readers = [first.read, second.read];
	globalThis.retainedImmutableReaders = readers;
	const operations = 100_000 * scale;
	for (let index = 0; index < operations; index++) {
		const read = readers[index & 1];
		checksum = (checksum + read(index & 15)) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}

runRuntimeGapCase("escaped-immutable-sparse-capture", run);
