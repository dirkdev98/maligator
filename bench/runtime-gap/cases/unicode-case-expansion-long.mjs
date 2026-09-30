import { runRuntimeGapCase } from "../case-runner.mjs";
const source = "Straße café Ελληνικά Σσς İstanbul ı 𐐨𐐩 ".repeat(256);
function run(scale) {
	const operations = 1000 * scale;
	let checksum = 0;
	for (let i = 0; i < operations; i++) {
		const value = source.toUpperCase();
		checksum += value.length + value.charCodeAt(0) + value.charCodeAt(value.length - 1);
	}
	return { checksum: checksum % 1000000007, operations };
}
runRuntimeGapCase("unicode-case-expansion-long", run);
