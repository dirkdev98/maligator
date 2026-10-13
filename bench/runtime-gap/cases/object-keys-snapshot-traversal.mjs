import { runRuntimeGapCase } from "../case-runner.mjs";

const records = [
	{ start: 0, end: 10, line: 2, column: 4 },
	{ kind: 1, left: 2, right: 3, operator: 4 },
	{ name: 1, value: 2, flags: 3, offset: 4, source: 5, parent: 6, next: 7, last: 8 },
];

function countKeyUnits(record) {
	const keys = Object.keys(record);
	let checksum = 0;
	for (let index = 0; index < keys.length; index++) checksum += keys[index].length;
	return checksum;
}

function run(scale) {
	let checksum = 0;
	const operations = 50_000 * scale;
	for (let index = 0; index < operations; index++) {
		checksum = (checksum + countKeyUnits(records[index % records.length])) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}

runRuntimeGapCase("object-keys-snapshot-traversal", run);
