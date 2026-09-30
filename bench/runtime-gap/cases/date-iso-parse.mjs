import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const values = Array.from({ length: 64 }, (_, i) =>
		new Date(1700000000000 + i * 1234567).toISOString(),
	);
	const operations = 80000 * scale;
	let checksum = 0;
	for (let i = 0; i < operations; i++) checksum += Date.parse(values[i & 63]) % 1000003;
	return { checksum: checksum % 1000000007, operations };
}

runRuntimeGapCase("date-iso-parse", run);
