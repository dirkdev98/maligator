import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const operations = 1400 * scale;
	let checksum = 0;
	for (let round = 0; round < operations; round++) {
		const source = "field:" + round + "|field|field|tail";
		const first = source.replace("field", "head");
		const all = first.replaceAll("field", "[$&]");
		const parts = all.split("|", 3 + (round & 1));
		if (parts.length !== 3 + (round & 1)) throw new Error("split limit failed");
		checksum += first.length + all.length;
		for (const part of parts) {
			checksum += part.length;
			for (let index = 0; index < part.length; index++)
				checksum += part.charCodeAt(index);
		}
	}
	return { checksum: checksum % 1000000007, operations };
}

runRuntimeGapCase("primordial-string-literal-rewrite-split", run);
