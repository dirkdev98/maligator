import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const values = Array.from({ length: 64 }, (_, i) =>
		i % 4 === 0 ? null : i % 4 === 1 ? undefined : i % 4 === 2 ? i : `field-${i}`,
	);
	const operations = 12000 * scale;
	let checksum = 0;
	for (let i = 0; i < operations; i++) {
		values[2] = i & 1023;
		const value = values.join("|");
		checksum += value.length + value.charCodeAt(i % value.length);
	}
	return { checksum: checksum % 1000000007, operations };
}

runRuntimeGapCase("array-join-mixed-values", run);
