import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const operations = 40000 * scale;
	let checksum = 0;
	for (let i = 0; i < operations; i++) {
		const error = new Error(`failure-${i & 1023}`);
		checksum += error.name.length + error.message.length;
	}
	return { checksum: checksum % 1000000007, operations };
}

runRuntimeGapCase("error-construction", run);
