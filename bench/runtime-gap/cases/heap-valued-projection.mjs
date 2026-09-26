import { runRuntimeGapCase } from "../case-runner.mjs";

function heapValuedProjection(scale) {
	const rows = Array.from({ length: 8192 }, (_, index) => ({
		left: { value: index & 1023 },
		right: { value: (index * 17) & 1023 },
		tag: { value: index & 31 },
	}));
	let checksum = 0;
	const rounds = 100 * scale;
	for (let round = 0; round < rounds; round++) {
		for (const row of rows) {
			const left = row.left;
			const right = row.right;
			const tag = row.tag;
			checksum += left.value + right.value + tag.value;
		}
	}
	return { checksum: checksum % 1000000007, operations: rows.length * rounds * 6 };
}
runRuntimeGapCase("heap-valued-projection", heapValuedProjection);
