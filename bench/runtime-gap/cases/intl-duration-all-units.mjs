import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const formatter = new Intl.DurationFormat("en-US", { style: "long" });
	const operations = 1000 * scale;
	let checksum = 0;
	for (let i = 0; i < operations; i++) {
		const text = formatter.format({
			years: 1,
			months: 2,
			weeks: 3,
			days: 4,
			hours: 5,
			minutes: 6,
			seconds: 7,
			milliseconds: 8,
			microseconds: 9,
			nanoseconds: 10,
		});
		checksum = (checksum + text.length + text.charCodeAt(i % text.length)) | 0;
	}
	return { operations, checksum: checksum >>> 0 };
}

runRuntimeGapCase("intl-duration-all-units", run);
