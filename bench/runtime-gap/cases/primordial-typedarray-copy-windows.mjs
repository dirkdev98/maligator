import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const source = [];
	for (let index = 0; index < 24; index++) source.push(index * 7);
	const operations = 600 * scale;
	let checksum = 0;
	for (let round = 0; round < operations; round++) {
		const increment = round & 31;
		const values = Uint32Array.from(source, (value) => value + increment);
		const view = values.subarray(2, 14);
		const copied = values.slice(1, 9);
		values.set(view, 0);
		values.copyWithin(4, 0, 8);
		values.fill(increment, 16, 24);
		if (
			values[0] !== 14 + increment ||
			copied[0] !== 7 + increment ||
			values[23] !== increment ||
			view[0] !== values[2]
		)
			throw new Error("typed copy failed");
		for (let index = 0; index < values.length; index++)
			checksum += values[index] * (index + 1);
		for (let index = 0; index < copied.length; index++) checksum += copied[index];
		for (let index = 0; index < view.length; index++) checksum += view[index];
	}
	return { checksum: checksum % 1000000007, operations };
}

runRuntimeGapCase("primordial-typedarray-copy-windows", run);
