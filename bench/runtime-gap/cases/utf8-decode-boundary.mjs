import { Buffer } from "node:buffer";
import { runRuntimeGapCase } from "../case-runner.mjs";

const sources = [
	"abcdefghijklmno".repeat(256),
	"café-déjà-vu-".repeat(256),
	"東京-Ā😀𝄞-".repeat(256),
	"\ud800a\udc00\0".repeat(256),
];
const buffers = sources.map((value) => Buffer.from(value, "utf8"));

function run(scale) {
	const operations = 20000 * scale;
	let checksum = 0;
	for (let i = 0; i < operations; i++) {
		const output = buffers[i & 3].toString("utf8");
		checksum +=
			output.length + output.charCodeAt(0) + output.charCodeAt(output.length - 1);
	}
	return { checksum: checksum % 1000000007, operations };
}

runRuntimeGapCase("utf8-decode-boundary", run);
