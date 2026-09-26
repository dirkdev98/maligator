import { runRuntimeGapCase } from "../case-runner.mjs";

function infrequentGetterProperties(scale) {
	let getterReads = 0;
	const rows = Array.from({ length: 8192 }, (_, index) => {
		if ((index & 255) !== 0) return { child: { value: index & 1023 } };
		return {
			get child() {
				getterReads++;
				return { value: index & 1023 };
			},
		};
	});
	let checksum = 0;
	const rounds = 100 * scale;
	for (let round = 0; round < rounds; round++) {
		for (const row of rows) checksum += row.child.value;
	}
	if (getterReads !== 32 * rounds) throw new Error("getter count mismatch");
	return {
		checksum: (checksum + getterReads) % 1000000007,
		operations: rows.length * rounds * 2,
	};
}
runRuntimeGapCase("infrequent-getter-properties", infrequentGetterProperties);
