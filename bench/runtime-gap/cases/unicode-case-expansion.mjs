import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const values = ["Straße café", "Ελληνικά Σσς", "İstanbul ı", "𐐨𐐩 mixed"];
	const operations = 80000 * scale;
	let checksum = 0;
	for (let i = 0; i < operations; i++) {
		const value = values[i & 3].toUpperCase();
		checksum += value.length + value.charCodeAt(i % value.length);
	}
	return { checksum: checksum % 1000000007, operations };
}

runRuntimeGapCase("unicode-case-expansion", run);
