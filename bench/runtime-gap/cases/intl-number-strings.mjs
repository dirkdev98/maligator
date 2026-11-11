import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const formatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 });
	const inputs = Array.from({ length: 64 }, (_, i) => String(10000 + i) + ".125");
	const operations = 1000 * scale;
	let checksum = 0;
	for (let i = 0; i < operations; i++) {
		const text = formatter.format(inputs[i % inputs.length]);
		checksum = (checksum + text.length + text.charCodeAt(i % text.length)) | 0;
	}
	return { operations, checksum: checksum >>> 0 };
}

runRuntimeGapCase("intl-number-strings", run);
