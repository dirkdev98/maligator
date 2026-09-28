import { runRuntimeGapCase } from "../case-runner.mjs";

const source = [];
for (let index = 0; index < 1024; index++) {
	const record = { value: index };
	record["unique-property-" + index] = index * 17;
	source.push(record);
}

function run(scale) {
	let checksum = 5381;
	const operations = 32 * scale;
	for (let batch = 0; batch < operations; batch++) {
		const output = JSON.stringify(source);
		for (let index = 0; index < output.length; index++) {
			checksum = ((checksum << 5) + checksum + output.charCodeAt(index)) | 0;
		}
	}
	return { checksum: checksum >>> 0, operations };
}

runRuntimeGapCase("json-unique-shapes", run);
