import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const operations = 12000 * scale;
	const modulus = (1n << 256n) - 159n;
	let state = (1n << 249n) + 123456789n;
	let checksum = 0;
	for (let i = 0; i < operations; i++) {
		state = (state * state + BigInt(i + 1)) % modulus;
		checksum += Number(state & 65535n);
	}
	return { checksum: checksum % 1000000007, operations };
}

runRuntimeGapCase("bigint-256-arithmetic", run);
