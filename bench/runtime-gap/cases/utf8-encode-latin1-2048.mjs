import { Buffer } from "node:buffer";
import { runRuntimeGapCase } from "../case-runner.mjs";

const source = "café-A".repeat(2048).slice(0, 2048);

function run(scale) {
	const operations = 10000 * scale;
	let checksum = 0;
	for (let i = 0; i < operations; i++) {
		const output = Buffer.from(source, "utf8");
		checksum += output.length + output[0] + output[output.length - 1];
	}
	return { checksum: checksum % 1000000007, operations };
}

runRuntimeGapCase("utf8-encode-latin1-2048", run);
