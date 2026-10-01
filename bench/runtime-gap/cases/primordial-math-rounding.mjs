import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const operations = 5000 * scale;
	let checksum = 0;
	for (let round = 0; round < operations; round++) {
		const value = ((round & 127) - 64) / 4;
		const absolute = Math.abs(value);
		const ceiling = Math.ceil(value);
		const floor = Math.floor(value);
		const rounded = Math.round(value);
		const truncated = Math.trunc(value);
		const sign = Math.sign(value);
		const expectedSign = value < 0 ? -1 : value > 0 ? 1 : 0;
		if (
			absolute !== (value < 0 ? -value : value) ||
			ceiling < value ||
			ceiling >= value + 1 ||
			floor > value ||
			floor <= value - 1 ||
			rounded !== floor + (value - floor >= 0.5 ? 1 : 0) ||
			(value < 0 && value >= -0.5 && 1 / rounded !== -Infinity) ||
			truncated !== (value < 0 ? ceiling : floor) ||
			sign !== expectedSign
		)
			throw new Error("rounding mismatch");
		checksum += absolute * 4 + ceiling + floor + rounded + truncated + sign;
	}
	return { checksum: ((checksum % 1000000007) + 1000000007) % 1000000007, operations };
}

runRuntimeGapCase("primordial-math-rounding", run);
