import { runRuntimeGapCase } from "../case-runner.mjs";

let source = { value: 17 };
for (let index = 0; index < 384; index++) source = { next: source };
function identity(key, value) {
	return value;
}

function run(scale) {
	let checksum = 5381;
	const operations = 64 * scale;
	for (let batch = 0; batch < operations; batch++) {
		const output = JSON.stringify(source, identity);
		for (let index = 0; index < output.length; index++) {
			checksum = ((checksum << 5) + checksum + output.charCodeAt(index)) | 0;
		}
	}
	return { checksum: checksum >>> 0, operations };
}

runRuntimeGapCase("json-replacer-depth", run);
