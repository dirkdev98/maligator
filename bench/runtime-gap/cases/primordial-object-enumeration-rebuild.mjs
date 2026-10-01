import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const operations = 700 * scale;
	let checksum = 0;
	for (let round = 0; round < operations; round++) {
		const record = {
			2: round & 255,
			label: round + 3,
			active: round & 1,
			total: round * 3,
		};
		const side = round & 1 ? "left" : "right";
		record[side] = round + 7;
		const expectedKeys = ["2", "label", "active", "total", side];
		const expectedValues = [round & 255, round + 3, round & 1, round * 3, round + 7];
		const keys = Object.keys(record);
		const values = Object.values(record);
		const entries = Object.entries(record);
		const rebuilt = Object.fromEntries(entries);
		const merged = Object.assign({}, rebuilt, { total: round * 5 });
		if (keys.length !== 5 || values.length !== 5 || entries.length !== 5)
			throw new Error("record enumeration length mismatch");
		for (let index = 0; index < keys.length; index++) {
			const expectedKey = expectedKeys[index];
			const expectedValue = expectedValues[index];
			if (
				keys[index] !== expectedKey ||
				values[index] !== expectedValue ||
				entries[index].length !== 2 ||
				entries[index][0] !== expectedKey ||
				entries[index][1] !== expectedValue ||
				rebuilt[expectedKey] !== expectedValue ||
				merged[expectedKey] !== (expectedKey === "total" ? round * 5 : expectedValue)
			)
				throw new Error("record enumeration or reconstruction mismatch");
			checksum +=
				(index + 1) *
				(keys[index].length +
					values[index] +
					entries[index][1] +
					rebuilt[keys[index]] +
					merged[keys[index]]);
		}
	}
	return { checksum: checksum % 1000000007, operations };
}

runRuntimeGapCase("primordial-object-enumeration-rebuild", run);
