import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const values = Array.from({ length: 16 }, (_, i) => `row:${i}|field|field|tail`);
	const operations = 80000 * scale;
	let checksum = 0;
	for (let i = 0; i < operations; i++) {
		const value = values[i & 15].replaceAll("field", "value-$&");
		checksum += value.length + value.charCodeAt(i % value.length);
	}
	return { checksum: checksum % 1000000007, operations };
}

runRuntimeGapCase("string-replace-all-literal", run);
