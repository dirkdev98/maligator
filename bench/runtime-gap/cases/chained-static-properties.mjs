import { runRuntimeGapCase } from "../case-runner.mjs";

function chainedStaticProperties(scale) {
	const rows = Array.from({ length: 8192 }, (_, index) => ({
		child: { meta: { value: index & 1023 } },
	}));
	let checksum = 0;
	const rounds = 100 * scale;
	for (let round = 0; round < rounds; round++) {
		for (const row of rows) checksum += row.child.meta.value;
	}
	return { checksum: checksum % 1000000007, operations: rows.length * rounds * 3 };
}
runRuntimeGapCase("chained-static-properties", chainedStaticProperties);
