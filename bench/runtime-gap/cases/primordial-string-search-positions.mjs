import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const operations = 2200 * scale;
	let checksum = 0;
	for (let round = 0; round < operations; round++) {
		const token = "key" + (round & 15);
		const text = "head|" + token + "|middle|" + token + "|tail";
		const needle = round & 1 ? token : "absent";
		const first = text.indexOf(needle, 2);
		const last = text.lastIndexOf(needle, text.length - 3);
		const includes = text.includes(needle, 4);
		const start = text.startsWith(token, 5);
		const end = text.endsWith(token, text.length - 5);
		if (!start || !end || includes !== ((round & 1) === 1))
			throw new Error("bounded string search failed");
		checksum += first + last + (includes ? 31 : 7) + (start ? 11 : 0) + (end ? 13 : 0);
	}
	return { checksum: checksum % 1000000007, operations };
}

runRuntimeGapCase("primordial-string-search-positions", run);
