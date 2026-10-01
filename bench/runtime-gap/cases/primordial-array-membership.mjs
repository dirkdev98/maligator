import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const values = Array.from({ length: 32 }, (_, index) => index & 7);
	values[15] = NaN;
	const operations = 2000 * scale;
	let checksum = 0;
	for (let round = 0; round < operations; round++) {
		const selector = round % 10;
		const target = selector === 9 ? NaN : selector;
		const included = values.includes(target);
		const first = values.indexOf(target);
		const last = values.lastIndexOf(target);
		const relative = -(1 + (round & 7));
		const tail = values.at(relative);
		const numericHit = selector < 8;
		if (
			included !== (numericHit || selector === 9) ||
			first !== (numericHit ? selector : -1) ||
			last !== (numericHit ? selector + 24 : -1) ||
			tail !== values[32 + relative]
		)
			throw new Error("membership mismatch");
		checksum += (included ? 23 : 0) + first + last + tail;
	}
	return { checksum: checksum % 1000000007, operations };
}

runRuntimeGapCase("primordial-array-membership", run);
