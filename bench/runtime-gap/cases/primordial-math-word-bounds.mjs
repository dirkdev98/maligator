import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const float = new Float32Array(1);
	const operations = 5000 * scale;
	let checksum = 0;
	for (let round = 0; round < operations; round++) {
		const value = (round * 104729) | 0;
		const minimum = Math.min(value, 100000, -100000);
		const maximum = Math.max(value, 100000, -100000);
		const product = Math.imul(value, 31);
		const bits = Math.clz32(value);
		const input = value / 7;
		const rounded = Math.fround(input);
		float[0] = input;
		if (
			minimum !== (value < -100000 ? value : -100000) ||
			maximum !== (value > 100000 ? value : 100000) ||
			product !== ((value * 31) | 0) ||
			rounded !== float[0] ||
			bits < 0 ||
			bits > 32 ||
			(value === 0 && bits !== 32) ||
			(value !== 0 && (value >>> 0) >>> (31 - bits) !== 1)
		)
			throw new Error("word math mismatch");
		checksum =
			(checksum + minimum + maximum + product + bits + Math.trunc(rounded)) % 1000000007;
	}
	return { checksum: (checksum + 1000000007) % 1000000007, operations };
}

runRuntimeGapCase("primordial-math-word-bounds", run);
