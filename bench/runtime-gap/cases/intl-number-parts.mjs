import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const formatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 });
	const operations = 1000 * scale;
	let checksum = 0;
	for (let i = 0; i < operations; i++) {
		for (const part of formatter.formatToParts((i % 10000) + 0.125))
			checksum = (checksum + part.type.length + part.value.length) | 0;
	}
	return { operations, checksum: checksum >>> 0 };
}

runRuntimeGapCase("intl-number-parts", run);
