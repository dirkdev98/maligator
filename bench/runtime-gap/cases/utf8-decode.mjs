import { Buffer } from "node:buffer";
import { runRuntimeGapCase } from "../case-runner.mjs";

const sources = [
	Buffer.from("abcdefghijklmno".repeat(256)),
	Buffer.from("caf\u00e9-d\u00e9j\u00e0-vu-".repeat(256)),
	Buffer.from("\u6771\u4eac-\u0100\ud83d\ude00\ud834\udd1e-".repeat(256)),
	Buffer.from([0xf0, 0x9f, 0x41, 0xed, 0xa0, 0x80, 0xe2, 0x82]),
];

function run(scale) {
	let checksum = 5381;
	const operations = 64 * scale;
	for (let batch = 0; batch < operations; batch++) {
		for (const source of sources) {
			const output = source.toString("utf8");
			for (let index = 0; index < output.length; index++) {
				checksum = ((checksum << 5) + checksum + output.charCodeAt(index)) | 0;
			}
		}
	}
	return { checksum: checksum >>> 0, operations: operations * sources.length };
}

runRuntimeGapCase("utf8-decode", run);
