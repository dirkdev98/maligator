import { runRuntimeGapCase } from "../case-runner.mjs";
function run(scale) {
	const values = Array.from({ length: 64 }, (_, i) => i);
	const operations = 12000 * scale;
	let checksum = 0;
	for (let i = 0; i < operations; i++) {
		values[2] = i & 1023;
		const value = values.join("|");
		checksum += value.length + value.charCodeAt(i % value.length);
	}
	return { checksum: checksum % 1000000007, operations };
}
runRuntimeGapCase("join-dense-int32s", run);
