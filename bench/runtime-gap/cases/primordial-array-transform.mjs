import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const source = Array.from({ length: 32 }, (_, index) => index);
	const operations = 600 * scale;
	let checksum = 0;
	for (let round = 0; round < operations; round++) {
		const mapped = source.map((value) => value * 3 + (round & 15));
		const filtered = mapped.filter((value) => (value & 1) === 0);
		const flattened = [filtered.slice(0, 8), filtered.slice(8)].flat();
		const expanded = flattened.flatMap((value) => [value, value + 1]);
		if (filtered.length !== 16 || flattened.length !== 16 || expanded.length !== 32)
			throw new Error("transform length mismatch");
		for (let index = 0; index < mapped.length; index++) checksum += mapped[index];
		for (let index = 0; index < expanded.length; index++)
			checksum += expanded[index] * (index + 1);
	}
	return { checksum: checksum % 1000000007, operations };
}

runRuntimeGapCase("primordial-array-transform", run);
