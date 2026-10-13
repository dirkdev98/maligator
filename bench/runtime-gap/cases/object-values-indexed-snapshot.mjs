import { runRuntimeGapCase } from "../case-runner.mjs";
function sum(record, observe) {
	const values = Object.values(record);
	let total = 0;
	for (let index = 0; index < values.length; index++) {
		total += values[index];
		if (index === 1) observe(record);
	}
	return total;
}
function replace(record) {
	record[2] = 0;
	record[3] = 0;
}
function run(scale) {
	let checksum = 0;
	const rounds = 40000 * scale;
	for (let index = 0; index < rounds; index++) {
		const record =
			index & 1 ? [index, index & 255, 3, 4] : { 0: index, 1: index & 255, 2: 3, 3: 4 };
		checksum = (checksum + sum(record, replace)) | 0;
	}
	return { checksum: checksum >>> 0, operations: rounds };
}
runRuntimeGapCase("object-values-indexed-snapshot", run);
