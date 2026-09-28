import { runRuntimeGapCase } from "../case-runner.mjs";

const source = [];
for (let index = 0; index < 1024; index++) source.push({ value: index });
let calls = 0;
source.push({
	get value() {
		calls++;
		return 1024;
	},
});

function run(scale) {
	let checksum = 5381;
	const operations = 32 * scale;
	calls = 0;
	for (let batch = 0; batch < operations; batch++) {
		const output = JSON.stringify(source);
		for (let index = 0; index < output.length; index++) {
			checksum = ((checksum << 5) + checksum + output.charCodeAt(index)) | 0;
		}
	}
	if (calls !== operations) throw new Error("serialization changed getter count");
	return { checksum: (checksum + calls) >>> 0, operations };
}

runRuntimeGapCase("json-late-fallback", run);
