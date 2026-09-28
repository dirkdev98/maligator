import { Buffer } from "node:buffer";
import { runRuntimeGapCase } from "../case-runner.mjs";

const sources = [
	"abcdefghijklmno".repeat(256),
	"caf\u00e9-d\u00e9j\u00e0-vu-".repeat(256),
	"\u6771\u4eac-\u0100\ud83d\ude00\ud834\udd1e-".repeat(256),
	"\ud800a\udc00\0".repeat(256),
];

function run(scale) {
	let checksum = 5381;
	const operations = 64 * scale;
	for (let batch = 0; batch < operations; batch++) {
		for (const source of sources) {
			const output = Buffer.from(source, "utf8");
			for (let index = 0; index < output.length; index++) {
				checksum = ((checksum << 5) + checksum + output[index]) | 0;
			}
		}
	}
	return { checksum: checksum >>> 0, operations: operations * sources.length };
}

runRuntimeGapCase("utf8-encode", run);
