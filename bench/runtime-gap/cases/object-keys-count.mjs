import { runRuntimeGapCase } from "../case-runner.mjs";
function count(record) {
	return Object.keys(record).length;
}
function run(scale) {
	const records = [
		{ a: 1, b: 2, c: 3 },
		{ x: 1, y: 2 },
		{ start: 0, end: 10, line: 2, column: 4 },
	];
	let checksum = 0;
	const rounds = 80000 * scale;
	for (let round = 0; round < rounds; round++)
		checksum += count(records[round % records.length]);
	return { checksum, operations: rounds };
}
runRuntimeGapCase("object-keys-count", run);
