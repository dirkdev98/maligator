import { runRuntimeGapCase } from "../case-runner.mjs";
function sumValues(record) {
	const values = Object.values(record);
	let total = 0;
	for (let index = 0; index < values.length; index++) total += values[index];
	return total;
}
function sumEntries(record) {
	const entries = Object.entries(record);
	let total = 0;
	for (let index = 0; index < entries.length; index++) {
		const pair = entries[index];
		total += pair[0].length + pair[1];
	}
	return total;
}
function run(scale) {
	let reads = 0;
	const records = [];
	for (let index = 0; index < 32; index++) {
		const record = index & 1 ? [] : {};
		Object.defineProperty(record, "0", {
			enumerable: true,
			get() {
				reads++;
				return index;
			},
		});
		record.second = index + 1;
		Object.defineProperty(record, "third", {
			enumerable: true,
			get() {
				reads++;
				return index + 2;
			},
		});
		record.last = index + 3;
		records.push(record);
	}
	const rounds = 50000 * scale;
	let checksum = 0;
	for (let index = 0; index < rounds; index++) {
		const record = records[index & 31];
		checksum = (checksum + sumValues(record) + sumEntries(record)) | 0;
	}
	return { checksum: (checksum + reads) >>> 0, operations: rounds * 2 };
}
runRuntimeGapCase("object-observed-enumeration", run);
