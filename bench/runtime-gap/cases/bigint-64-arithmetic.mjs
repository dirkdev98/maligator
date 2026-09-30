import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const operations = 60000 * scale;
	let state = (1n << 63n) + 17n;
	let checksum = 0;
	for (let i = 0; i < operations; i++) {
		state = BigInt.asUintN(64, state * 6364136223846793005n + BigInt(i & 255));
		checksum += Number(state & 65535n);
	}
	return { checksum: checksum % 1000000007, operations };
}

runRuntimeGapCase("bigint-64-arithmetic", run);
