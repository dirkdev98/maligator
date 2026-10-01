import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const operations = 3000 * scale;
	let checksum = 0;
	for (let round = 0; round < operations; round++) {
		const value = ((round & 31) + 1) / 16;
		const exponent = (round & 7) + 1;
		const exponential = Math.exp(value);
		const delta = Math.expm1(value);
		const logarithm = Math.log(exponential);
		const binaryLog = Math.log2(1 << exponent);
		const cube = Math.pow(value, 3);
		const root = Math.sqrt(value * value);
		if (
			!Number.isFinite(exponential) ||
			!Number.isFinite(delta) ||
			!Number.isFinite(logarithm) ||
			Math.abs(logarithm - value) > 1e-12 ||
			Math.abs(delta + 1 - exponential) > 1e-12 ||
			binaryLog !== exponent ||
			cube !== value * value * value ||
			root !== value
		)
			throw new Error("power/logarithm mismatch");
		checksum += Math.round(
			(exponential + delta + logarithm + binaryLog + cube + root) * 10000,
		);
	}
	return { checksum: checksum % 1000000007, operations };
}

runRuntimeGapCase("primordial-math-powers-logarithms", run);
