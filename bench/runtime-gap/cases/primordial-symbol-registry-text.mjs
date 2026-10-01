import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const operations = 2000 * scale;
	let checksum = 0;
	for (let round = 0; round < operations; round++) {
		const key = "primordial-entry-" + (round & 31);
		const symbol = Symbol.for(key);
		const text = symbol.toString();
		if (symbol !== Symbol.for(key) || text !== "Symbol(" + key + ")")
			throw new Error("symbol registry failed");
		for (let index = 0; index < text.length; index++) checksum += text.charCodeAt(index);
		checksum += text.length;
	}
	return { checksum: checksum % 1000000007, operations };
}

runRuntimeGapCase("primordial-symbol-registry-text", run);
