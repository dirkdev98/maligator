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
		checksum =
			(checksum +
				output.length +
				output.charCodeAt(0) +
				output.charCodeAt(output.length - 1)) |
			0;
	}
	return { checksum: checksum >>> 0, operations };
}

runRuntimeGapCase("json-unique-serialize", run);
