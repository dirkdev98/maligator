import { runRuntimeGapCase } from "../case-runner.mjs";
function run(scale) {
	const operations = 100 * scale;
	let checksum = 0;
	for (let i = 0; i < operations; i++) {
		const formatter = new Intl.NumberFormat("en-US", {
			style: "unit",
			unit: i % 2 === 0 ? "meter-per-second" : "hour-per-meter",
			unitDisplay: "long",
			maximumFractionDigits: 3,
		});
		const text = formatter.format((i % 10000) + 0.125);
		checksum = (checksum + text.length + text.charCodeAt(i % text.length)) | 0;
	}
	return { operations, checksum: checksum >>> 0 };
}
runRuntimeGapCase("intl-number-unit-construct", run);
