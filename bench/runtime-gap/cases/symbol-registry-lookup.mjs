import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const keys = Array.from({ length: 64 }, (_, i) => `registry-${i}`);
	const operations = 200000 * scale;
	let checksum = 0;
	for (let i = 0; i < operations; i++) {
		const symbol = Symbol.for(keys[i & 63]);
		checksum +=
			Symbol.keyFor(symbol).length + (symbol === Symbol.for(keys[i & 63]) ? 1 : 0);
	}
	return { checksum: checksum % 1000000007, operations };
}

runRuntimeGapCase("symbol-registry-lookup", run);
