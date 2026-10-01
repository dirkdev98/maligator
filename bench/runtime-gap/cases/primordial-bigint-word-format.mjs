import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const operations = 1200 * scale;
	let state = 0x123456789abcdefn;
	let checksum = 0;
	for (let round = 0; round < operations; round++) {
		state = BigInt.asUintN(64, state * 1664525n + BigInt(round + 1));
		const radix = (round & 1) === 0 ? 10 : 16;
		const text = state.toString(radix);
		const parsed = BigInt(radix === 16 ? "0x" + text : text);
		if (state < 0n || state >= 18446744073709551616n || parsed !== state)
			throw new Error("BigInt word mismatch");
		for (let index = 0; index < text.length; index++)
			checksum += text.charCodeAt(index) * (index + 1);
	}
	return { checksum: checksum % 1000000007, operations };
}

runRuntimeGapCase("primordial-bigint-word-format", run);
