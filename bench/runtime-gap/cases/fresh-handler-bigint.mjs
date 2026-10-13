import { runRuntimeGapCase } from "../case-runner.mjs";
const retained = new Array(32);
function prepareRecord(reference, observe) {
	let tag;
	try {
		tag = observe(reference);
	} catch (error) {
		tag = error;
	}
	return [
		reference,
		tag,
		123456789012345678901234567890n,
		"record",
		null,
		undefined,
		true,
		0n,
		reference,
	];
}
function tagRecord(reference) {
	return reference.marker;
}
function run(scale) {
	let checksum = 0;
	const reference = { marker: 7 };
	const rounds = 20000 * scale;
	for (let i = 0; i < rounds; i++) {
		const record = prepareRecord(reference, tagRecord);
		retained[i & 31] = record;
		checksum =
			(checksum +
				record.length +
				record[1] +
				(record[0] === reference ? 7 : 0) +
				(record[2] === 123456789012345678901234567890n ? 3 : 0)) |
			0;
	}
	for (let i = 0; i < 32; i++) checksum = (checksum + retained[i].length) | 0;
	return { checksum: checksum >>> 0, operations: rounds };
}
runRuntimeGapCase("fresh-handler-bigint", run);
