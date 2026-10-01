import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const values = new Float64Array(24);
	const operations = 600 * scale;
	let checksum = 0;
	for (let round = 0; round < operations; round++) {
		for (let index = 0; index < values.length; index++)
			values[index] = index * 0.5 + (round & 15);
		const mapped = values.map((value) => value * 2 + 0.25);
		const filtered = mapped.filter(
			(value, index) => index % 3 !== round % 3 && value > 0,
		);
		const reduced = filtered.reduce((sum, value) => sum + value, 0);
		const some = filtered.some((value) => value > 30 + (round & 15));
		const probe = round & 1 ? mapped[round % mapped.length] : -1;
		const included = mapped.includes(probe);
		const index = mapped.indexOf(probe);
		if (
			included !== ((round & 1) === 1) ||
			(included && index < 0) ||
			filtered.length !== 16
		)
			throw new Error("typed query failed");
		checksum +=
			reduced * 4 + filtered.length + (some ? 13 : 7) + (included ? index + 31 : 3);
		checksum += mapped[(round + 5) % mapped.length] * 4;
	}
	return { checksum: checksum % 1000000007, operations };
}

runRuntimeGapCase("primordial-typedarray-transform-query", run);
