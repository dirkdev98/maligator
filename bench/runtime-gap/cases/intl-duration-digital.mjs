import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const formatter = new Intl.DurationFormat("en-US", { style: "digital" });
	const operations = 1000 * scale;
	let checksum = 0;
	for (let i = 0; i < operations; i++) {
		const text = formatter.format({
			hours: 1 + (i % 9),
			minutes: i % 59,
			seconds: 1 + (i % 59),
		});
		checksum = (checksum + text.length + text.charCodeAt(i % text.length)) | 0;
	}
	return { operations, checksum: checksum >>> 0 };
}

runRuntimeGapCase("intl-duration-digital", run);
