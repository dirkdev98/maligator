import { Buffer } from "node:buffer";
import { runRuntimeGapCase } from "../case-runner.mjs";

const sources = [
	"abcdefghijklmno".repeat(256),
	"café-déjà-vu-".repeat(256),
	"東京-Ā😀𝄞-".repeat(256),
	"\ud800a\udc00\0".repeat(256),
];

function run(scale) {
	const operations = 20000 * scale;
	let checksum = 0;
	for (let i = 0; i < operations; i++) {
		const output = Buffer.from(sources[i & 3], "utf8");
		checksum += output.length + output[0] + output[output.length - 1];
	}
	return { checksum: checksum % 1000000007, operations };
}

runRuntimeGapCase("utf8-encode-boundary", run);
