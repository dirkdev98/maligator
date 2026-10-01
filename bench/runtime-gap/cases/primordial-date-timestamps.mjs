import { runRuntimeGapCase } from "../case-runner.mjs";

const records = [
	["2020-02-29T12:34:56.789Z", 2020, 1, 29, 12, 34, 56, 789],
	["2021-12-31T23:59:59.001Z", 2021, 11, 31, 23, 59, 59, 1],
	["2024-03-01T00:00:00.125Z", 2024, 2, 1, 0, 0, 0, 125],
	["2026-10-01T15:45:30.500Z", 2026, 9, 1, 15, 45, 30, 500],
];

function run(scale) {
	const date = new Date(0);
	const operations = 800 * scale;
	let checksum = 0;
	for (let round = 0; round < operations; round++) {
		const record = records[round & 3];
		const parsed = Date.parse(record[0]);
		const constructed = Date.UTC(
			record[1],
			record[2],
			record[3],
			record[4],
			record[5],
			record[6],
			record[7],
		);
		const updated = date.setTime(parsed + (round & 1023));
		const read = date.getTime();
		const now = Date.now();
		if (parsed !== constructed || updated !== parsed + (round & 1023) || read !== updated)
			throw new Error("timestamp conversion mismatch");
		if (
			!Number.isFinite(now) ||
			now % 1 !== 0 ||
			now < 1577836800000 ||
			now > 4102444800000
		)
			throw new Error("invalid current timestamp");
		checksum += (read % 1000003) + (constructed % 1000003) + 1;
	}
	return { checksum: checksum % 1000000007, operations };
}

runRuntimeGapCase("primordial-date-timestamps", run);
