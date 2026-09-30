import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const operations = 60000 * scale;
	const modulus = (1n << 115n) - 1n;
	let state = (1n << 110n) + 17n;
	let checksum = 0;
	for (let i = 0; i < operations; i++) {
		state = (state * 17n + BigInt(i & 255)) % modulus;
		checksum += Number(state % 1000003n);
	}
	return { checksum: checksum % 1000000007, operations };
}

runRuntimeGapCase("bigint-wide-modular-arithmetic", run);
