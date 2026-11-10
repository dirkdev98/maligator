import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const formatter = new Intl.RelativeTimeFormat("en-US");
	const operations = 1000 * scale;
	let checksum = 0;
	for (let i = 0; i < operations; i++) {
		const parts = formatter.formatToParts(1 + (i % 99), "day");
		for (const part of parts)
			checksum =
				(checksum + part.value.length + part.type.length + part.value.charCodeAt(0)) | 0;
	}
	return { operations, checksum: checksum >>> 0 };
}

runRuntimeGapCase("intl-relative-time-parts", run);
