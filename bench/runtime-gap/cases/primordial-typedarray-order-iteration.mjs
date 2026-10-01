import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const operations = 550 * scale;
	let checksum = 0;
	for (let round = 0; round < operations; round++) {
		const values = new Float64Array(24);
		for (let index = 0; index < values.length; index++)
			values[index] = ((index * 17 + round) % 41) - 20;
		const first = values[0];
		values.reverse();
		if (values[23] !== first) throw new Error("typed reverse failed");
		checksum += (values[0] + 32) * 3 + values[23] + 32;
		values.sort();
		let index = 0;
		let previous = -Infinity;
		for (const value of values.values()) {
			if (value < previous) throw new Error("typed sort order failed");
			checksum += (value + 32) * (index + 1);
			previous = value;
			index++;
		}
		if (index !== values.length) throw new Error("typed iterator did not drain");
		const joined = values.join(round & 1 ? ":" : "|");
		for (let position = 0; position < joined.length; position++)
			checksum += joined.charCodeAt(position);
	}
	return { checksum: checksum % 1000000007, operations };
}

runRuntimeGapCase("primordial-typedarray-order-iteration", run);
