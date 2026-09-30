import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const operations = 40000 * scale;
	let checksum = 0;
	for (let i = 0; i < operations; i++) {
		const value = new Date(1700000000000 + (i & 65535) * 1234567).toISOString();
		checksum += value.length + value.charCodeAt(18) + value.charCodeAt(22);
	}
	return { checksum: checksum % 1000000007, operations };
}

runRuntimeGapCase("date-iso-format", run);
