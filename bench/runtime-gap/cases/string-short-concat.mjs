import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	let checksum = 0;
	const operations = 250_000 * scale;
	for (let index = 0; index < operations; index++) {
		const key = `function:${index & 1_023}:block:${(index * 17) & 255}`;
		checksum = (checksum + key.length + key.charCodeAt(key.length - 1)) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}

runRuntimeGapCase("string-short-concat", run);
