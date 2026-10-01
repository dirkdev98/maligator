import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const operations = 400 * scale;
	let checksum = 0;
	for (let round = 0; round < operations; round++) {
		const rows = [];
		for (let index = 0; index < 8; index++)
			rows.push({ group: (index + round) & 1, value: round + index });
		const groups = Object.groupBy(rows, (row) => (row.group ? "odd" : "even"));
		const summary = { first: groups.even[0].value, second: groups.odd[0].value };
		const frozen = Object.freeze(summary);
		const same = Object.is(frozen, summary);
		const writable = Reflect.set(frozen, "first", -1);
		const zero = round & 1 ? -0 : 0;
		const negative = Object.is(zero, -0);
		if (!same || writable || frozen.first < 0) throw new Error("frozen summary changed");
		for (const row of groups.even) checksum += row.value;
		for (const row of groups.odd) checksum += row.value * 3;
		checksum += frozen.first + frozen.second + (negative ? 19 : 23);
	}
	return { checksum: checksum % 1000000007, operations };
}

runRuntimeGapCase("primordial-object-group-freeze-identity", run);
