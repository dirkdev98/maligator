import { runRuntimeGapCase } from "../case-runner.mjs";
function run(scale) {
	const formatter = new Intl.DurationFormat("en-US", { style: "long" });
	const operations = 100 * scale;
	let checksum = 0;
	for (let i = 0; i < operations; i++) {
		const parts = formatter.formatToParts({
			hours: 1,
			minutes: i % 60,
			seconds: 3,
			milliseconds: 125,
		});
		for (let j = 0; j < parts.length; j++)
			checksum =
				(checksum +
					parts[j].type.length +
					parts[j].value.length +
					(parts[j].unit?.length ?? 0) +
					parts[j].value.charCodeAt((i + j) % parts[j].value.length)) |
				0;
	}
	return { operations, checksum: checksum >>> 0 };
}
runRuntimeGapCase("intl-duration-parts", run);
