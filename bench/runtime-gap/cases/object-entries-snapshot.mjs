import { runRuntimeGapCase } from "../case-runner.mjs";

function sample(record, index, observe) {
	const entries = Object.entries(record);
	if (index === 1) observe(record);
	const pair = entries[index];
	return entries.length + pair[0].length + pair[1];
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
			(checksum +
				sample({ first: i, second: i & 255, third: 3, fourth: 4 }, i & 1, replace)) |
			0;
	return { checksum: checksum >>> 0, operations: rounds };
}
runRuntimeGapCase("object-entries-snapshot", run);
