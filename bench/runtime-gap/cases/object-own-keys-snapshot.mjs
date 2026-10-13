import { runRuntimeGapCase } from "../case-runner.mjs";
function inspect(record, marker) {
	const names = Object.getOwnPropertyNames(record);
	const symbols = Object.getOwnPropertySymbols(record);
	let total = names.length * 7 + symbols.length;
	for (let index = 0; index < names.length; index++) total += names[index].length;
	for (let index = 0; index < symbols.length; index++)
		total += symbols[index] === marker ? 11 : 3;
	return total;
}
function run(scale) {
	const marker = Symbol("marker");
	const records = [{ 2: 1, 0: 3, tail: 4 }, [1, , 3]];
	for (const record of records) {
		Object.defineProperty(record, "hidden", { value: 5 });
		Object.defineProperty(record, marker, { value: 6 });
		record[Symbol("other")] = 7;
	}
	let checksum = 0;
	const rounds = 100000 * scale;
	for (let index = 0; index < rounds; index++)
		checksum = (checksum + inspect(records[index & 1], marker)) | 0;
	return { checksum: checksum >>> 0, operations: rounds * 2 };
}
runRuntimeGapCase("object-own-keys-snapshot", run);
