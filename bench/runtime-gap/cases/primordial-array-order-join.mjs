import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const operations = 500 * scale;
	let checksum = 0;
	for (let round = 0; round < operations; round++) {
		const values = Array.from({ length: 32 }, (_, index) => (index * 13 + round) & 63);
		const first = values[0];
		const copied = values.toSorted((left, right) => left - right);
		if (values[0] !== first) throw new Error("toSorted mutated input");
		values.sort((left, right) => left - right);
		for (let index = 0; index < values.length; index++) {
			if (
				values[index] !== copied[index] ||
				(index > 0 && values[index - 1] > values[index])
			)
				throw new Error("sort mismatch");
			checksum += copied[index];
		}
		const text = values.join(":");
		for (let index = 0; index < text.length; index++)
			checksum += text.charCodeAt(index) * (index + 1);
	}
	return { checksum: checksum % 1000000007, operations };
}

runRuntimeGapCase("primordial-array-order-join", run);
