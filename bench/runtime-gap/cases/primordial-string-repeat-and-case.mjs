import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const inputs = ["Straße É", "Σίσυφος", "Cafe MIX", "𐐀Ab"];
	const operations = 1000 * scale;
	let checksum = 0;
	for (let round = 0; round < operations; round++) {
		const repeated = inputs[round & 3].repeat(1 + (round % 3));
		const lower = repeated.toLowerCase();
		const upper = repeated.toUpperCase();
		checksum += repeated.length + lower.length * 3 + upper.length * 5;
		for (let index = 0; index < lower.length; index++)
			checksum += lower.charCodeAt(index);
		for (let index = 0; index < upper.length; index++)
			checksum += upper.charCodeAt(index);
	}
	return { checksum: checksum % 1000000007, operations };
}

runRuntimeGapCase("primordial-string-repeat-and-case", run);
