import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const formatter = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" });
	const operations = 500 * scale;
	let checksum = 0;
	for (let i = 0; i < operations; i++) {
		const epoch = 1700000000000 + (i % 27) * 86400000;
		for (const part of formatter.formatToParts(epoch)) {
			checksum =
				(checksum +
					part.type.length +
					part.value.length +
					part.value.charCodeAt(i % part.value.length)) |
				0;
		}
	}
	return { operations, checksum: checksum >>> 0 };
}

runRuntimeGapCase("intl-datetime-parts", run);
