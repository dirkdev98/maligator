import { runRuntimeGapCase } from "../case-runner.mjs";
function count(record) {
	const keys = Object.keys(record);
	const values = Object.values(record);
	const entries = Object.entries(record);
	const names = Object.getOwnPropertyNames(record);
	const symbols = Object.getOwnPropertySymbols(record);
	return keys.length + values.length + entries.length + names.length + symbols.length;
}
function run(scale) {
	const records = [{}, []];
	for (const record of records) {
		for (let index = 0; index < 129; index++) record[index] = index;
		Object.defineProperty(record, "hidden", { value: 1 });
		record[Symbol("one")] = 2;
	}
	let checksum = 0;
	const rounds = 20000 * scale;
	for (let index = 0; index < rounds; index++)
		checksum = (checksum + count(records[index & 1])) | 0;
	return { checksum: checksum >>> 0, operations: rounds * 5 };
}
runRuntimeGapCase("object-enumeration-counts", run);
