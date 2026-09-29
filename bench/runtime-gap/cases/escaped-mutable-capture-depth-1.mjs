import { runRuntimeGapCase } from "../case-runner.mjs";

// Each escaped keeper makes the intermediate lexical owner observable.
function make(seed) {
	let value = seed;
	const retainedLeaf = seed + 1;
	return {
		keep: () => retainedLeaf,
		read: function read(delta) {
			let sum = 0;
			for (let step = 0; step < 16; step++) {
				value = (value + delta + step) & 255;
				sum += value;
			}
			return sum;
		},
	};
}

function run(scale) {
	const retained = [];
	const readers = [];
	const seed = Number(process.argv[2] ?? "1") & 255;
	for (let index = 0; index < 2; index++) {
		let next = make(seed + index);
		for (let depth = 1; depth < 1; depth++) {
			retained.push(next);
			next = next.next();
		}
		retained.push(next);
		readers.push(next.read);
	}
	globalThis.retainedCaptureScopes = retained;
	let checksum = 0;
	const operations = 100_000 * scale;
	for (let index = 0; index < operations; index++) {
		const read = readers[index & 1];
		checksum = (checksum + read(index & 15)) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}

runRuntimeGapCase("escaped-mutable-capture-depth-1", run);
