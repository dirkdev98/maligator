import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const operations = 800 * scale;
	let checksum = 0;
	for (let round = 0; round < operations; round++) {
		const year = 2020 + (round % 5);
		const month = round % 12;
		const day = 1 + (round % 28);
		const date = new Date(
			Date.UTC(year, month, day, round % 24, round % 60, (round * 7) % 60, round % 1000),
		);
		const actualYear = date.getUTCFullYear();
		const actualMonth = date.getUTCMonth();
		const actualDay = date.getUTCDate();
		const iso = date.toISOString();
		const json = date.toJSON();
		if (
			actualYear !== year ||
			actualMonth !== month ||
			actualDay !== day ||
			iso !== json ||
			iso.length !== 24
		)
			throw new Error("UTC formatting mismatch");
		checksum += actualYear + actualMonth * 31 + actualDay;
		for (let index = 0; index < iso.length; index++)
			checksum += iso.charCodeAt(index) * (index + 1) + json.charCodeAt(index);
	}
	return { checksum: checksum % 1000000007, operations };
}

runRuntimeGapCase("primordial-date-utc-format", run);
