import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const operations = 1200 * scale;
	let checksum = 0;
	for (let round = 0; round < operations; round++) {
		const year = 2020 + (round % 5);
		const month = round % 12;
		const day = 1 + (round % 28);
		const date = new Date(Date.UTC(year, month, day, 12, 30));
		const actualYear = date.getFullYear();
		const actualMonth = date.getMonth();
		const actualDay = date.getDate();
		if (actualYear !== year || actualMonth !== month || actualDay !== day)
			throw new Error("local calendar mismatch; run with TZ=UTC");
		checksum += actualYear + actualMonth * 31 + actualDay;
	}
	return { checksum: checksum % 1000000007, operations };
}

runRuntimeGapCase("primordial-date-local-calendar", run);
