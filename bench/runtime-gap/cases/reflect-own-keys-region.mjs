import { runRuntimeGapCase } from "../case-runner.mjs";
function inspect(record, marker) {
	const keys = Reflect.ownKeys(record);
	let total = keys.length * 7;
	for (let index = 0; index < keys.length; index++) {
		const key = keys[index];
		total += typeof key === "symbol" ? (key === marker ? 11 : 3) : key.length;
	}
	return total;
}
function count(record) {
	return Reflect.ownKeys(record).length;
}
function run(scale) {
	const marker = Symbol("marker");
	const records = [{ 2: 1, 0: 3, tail: 4 }, [1, , 3]];
	for (const record of records) {
		Object.defineProperty(record, "hidden", { value: 5 });
		record[marker] = 6;
		record[Symbol("other")] = 7;
	}
	const wide = {};
	for (let index = 0; index < 64; index++) {
		wide[index] = index;
		wide[Symbol("key")] = index;
	}
	let checksum = 0;
	const rounds = 100000 * scale;
	for (let index = 0; index < rounds; index++)
		checksum = (checksum + inspect(records[index & 1], marker) + count(wide)) | 0;
	return { checksum: checksum >>> 0, operations: rounds * 2 };
}
runRuntimeGapCase("reflect-own-keys-region", run);
