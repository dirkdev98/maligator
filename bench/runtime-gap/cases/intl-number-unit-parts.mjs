import { runRuntimeGapCase } from "../case-runner.mjs";
function run(scale) {
	const formatter = new Intl.NumberFormat("en-US", {
		style: "unit",
		unit: "meter-per-second",
		unitDisplay: "long",
		maximumFractionDigits: 3,
	});
	const operations = 1000 * scale;
	let checksum = 0;
	for (let i = 0; i < operations; i++) {
		const parts = formatter.formatToParts((i % 10000) + 0.125);
		for (let j = 0; j < parts.length; j++)
			checksum =
				(checksum +
					parts[j].type.length +
					parts[j].value.length +
					parts[j].value.charCodeAt((i + j) % parts[j].value.length)) |
				0;
	}
	return { operations, checksum: checksum >>> 0 };
}
runRuntimeGapCase("intl-number-unit-parts", run);
