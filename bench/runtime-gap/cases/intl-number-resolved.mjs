import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const formatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 });
	const operations = 100 * scale;
	let checksum = 0;
	for (let i = 0; i < operations; i++) {
		const resolved = formatter.resolvedOptions();
		checksum =
			(checksum +
				resolved.locale.length +
				resolved.numberingSystem.length +
				resolved.minimumIntegerDigits +
				resolved.maximumFractionDigits) |
			0;
	}
	return { operations, checksum: checksum >>> 0 };
}

runRuntimeGapCase("intl-number-resolved", run);
