import { runRuntimeGapCase } from "../case-runner.mjs";
const source = "a\u0315\u0300\u0327".repeat(2048);
function run(scale) {
	const operations = 500 * scale;
	let checksum = 0;
	for (let i = 0; i < operations; i++) {
		const value = source.normalize("NFC");
		checksum += value.length + value.charCodeAt(0) + value.charCodeAt(value.length - 1);
	}
	return { checksum: checksum % 1000000007, operations };
}
runRuntimeGapCase("unicode-normalize-nfc-long", run);
