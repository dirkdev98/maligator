import { runRuntimeGapCase } from "../case-runner.mjs";

const values = [-1, 0, 1, 12];

function run(scale) {
	const formatter = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" });
	const operations = 1000 * scale;
	let checksum = 0;
	for (let i = 0; i < operations; i++) {
		const text = formatter.format(values[i & 3], "day");
		checksum = (checksum + text.length + text.charCodeAt(i % text.length)) | 0;
	}
	return { operations, checksum: checksum >>> 0 };
}

runRuntimeGapCase("intl-relative-time-auto", run);
