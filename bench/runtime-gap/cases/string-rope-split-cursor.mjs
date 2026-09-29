import { runRuntimeGapCase } from "../case-runner.mjs";

const fields = [];
for (let index = 0; index < 1024; index++) {
	fields.push(" \tfield-" + index + "-" + "x".repeat(index % 17) + "\t ");
}
let value = "";
for (const field of fields) {
	if (value.length !== 0) value += "|";
	value += field;
}

function sumTrimmedLengths(value, separator) {
	const fields = value.split(separator);
	let total = 0;
	for (let index = 0; index < fields.length; index++) {
		const part = fields[index].trim();
		total = (total * 33 + part.length) | 0;
	}
	return total;
}

function run(scale) {
	let checksum = 0;
	const operations = 32 * scale;
	for (let batch = 0; batch < operations; batch++) {
		checksum = (checksum + sumTrimmedLengths(value, "|")) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}

runRuntimeGapCase("string-rope-split-cursor", run);
