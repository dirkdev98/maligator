import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const operations = 1000 * scale;
	let checksum = 0;
	for (let i = 0; i < operations; i++) {
		const text = ((i % 10000) + 0.125).toLocaleString();
		checksum = (checksum + text.length + text.charCodeAt(i % text.length)) | 0;
	}
	return { operations, checksum: checksum >>> 0 };
}

runRuntimeGapCase("intl-number-locale", run);
