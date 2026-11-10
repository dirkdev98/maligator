import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const formatter = new Intl.RelativeTimeFormat("en-US");
	const operations = 1000 * scale;
	let checksum = 0;
	for (let i = 0; i < operations; i++) {
		const text = formatter.format(1 + (i % 99), "day");
		checksum = (checksum + text.length + text.charCodeAt(i % text.length)) | 0;
	}
	return { operations, checksum: checksum >>> 0 };
}

runRuntimeGapCase("intl-relative-time-reuse", run);
