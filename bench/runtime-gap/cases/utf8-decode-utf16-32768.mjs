import { Buffer } from "node:buffer";
import { runRuntimeGapCase } from "../case-runner.mjs";
const input = Buffer.from("東京Ā中".repeat(8192), "utf8");
function run(scale) {
	const operations = 1000 * scale;
	let checksum = 0;
	for (let i = 0; i < operations; i++) {
		const value = input.toString("utf8");
		checksum += value.length + value.charCodeAt(0) + value.charCodeAt(value.length - 1);
	}
	return { checksum: checksum % 1000000007, operations };
}
runRuntimeGapCase("utf8-decode-utf16-32768", run);
