import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const operations = 600 * scale;
	let state = (1n << 1023n) + 123456789n;
	let checksum = 0;
	for (let i = 0; i < operations; i++) {
		const decimal = state.toString();
		const hex = state.toString(16);
		if (BigInt(decimal) !== state || BigInt("0x" + hex) !== state)
			throw new Error("BigInt text round-trip mismatch");
		checksum += decimal.charCodeAt(i % decimal.length) + hex.charCodeAt(i % hex.length);
		state += BigInt(i + 1);
	}
	return { checksum: checksum % 1000000007, operations };
}

runRuntimeGapCase("bigint-wide-text", run);
