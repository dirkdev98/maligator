import { runRuntimeGapCase } from "../case-runner.mjs";

const seed = Number(process.argv[2] ?? "1") & 255;

function makeCell(initial) {
	let value = initial;
	return {
		get: () => value,
		set: (next) => {
			value = next;
		},
	};
}

const cells = Array.from({ length: 64 }, (_, index) => makeCell(seed + index));

function run(scale) {
	let checksum = 0;
	const iterations = 250_000 * scale;
	for (let index = 0; index < iterations; index++) {
		const cell = cells[index & 63];
		cell.set((seed + index) & 255);
		checksum = (checksum + cell.get()) | 0;
	}
	return { checksum: checksum >>> 0, operations: iterations * 2 };
}

runRuntimeGapCase("shared-mutable-capture-lexical-64", run);
