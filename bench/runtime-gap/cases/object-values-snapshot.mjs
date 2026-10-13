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
	record.third = 0;
	record.fourth = 0;
}
function run(scale) {
	let checksum = 0;
	const rounds = 40000 * scale;
	for (let i = 0; i < rounds; i++)
		checksum =
			(checksum + sum({ first: i, second: i & 255, third: 3, fourth: 4 }, replace)) | 0;
	return { checksum: checksum >>> 0, operations: rounds };
}
runRuntimeGapCase("object-values-snapshot", run);
