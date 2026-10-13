import { runRuntimeGapCase } from "../case-runner.mjs";
function sumAfterHandler(record, observe) {
	try {
		observe(record);
	} catch (error) {}
	const values = Object.values(record);
	let total = 0;
	for (let i = 0; i < values.length; i++) total += values[i];
	return total;
}
function inspect(record) {
	return record.first;
}
function run(scale) {
	const rounds = 40000 * scale;
	let checksum = 0;
	for (let i = 0; i < rounds; i++)
		checksum =
			(checksum +
				sumAfterHandler({ first: i, second: i & 255, third: 3, fourth: 4 }, inspect)) |
			0;
	return { checksum: checksum >>> 0, operations: rounds };
}
runRuntimeGapCase("enumeration-after-handler", run);
