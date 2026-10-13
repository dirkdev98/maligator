import { runRuntimeGapCase } from "../case-runner.mjs";

function read(input, freeze) {
	const record = { start: input, end: input + 7, flag: true };
	if (freeze) Object.freeze(record);
	return record.end - record.start + (record.flag ? 1 : 0);
}
function run(scale) {
	let checksum = 0;
	const rounds = 80000 * scale;
	for (let i = 0; i < rounds; i++) checksum += read(i, (i & 7) === 0);
	return { checksum, operations: rounds };
}
runRuntimeGapCase("known-object-observation", run);
