import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const operations = 550 * scale;
	let checksum = 0;
	for (let round = 0; round < operations; round++) {
		const text =
			"a=" + (round & 255) + ";b=" + ((round + 7) & 255) + ";c=" + ((round + 13) & 255);
		const first = text.match(/^a=(\d+);/);
		const offset = text.search(/b=\d+/);
		if (first === null || offset <= 0) throw new Error("string regexp match failed");
		checksum += Number(first[1]) + first[0].length + offset;
		let count = 0;
		for (const match of text.matchAll(/([abc])=(\d+)/g)) {
			checksum += match[1].charCodeAt(0) + Number(match[2]) + match.index;
			count++;
		}
		if (count !== 3) throw new Error("matchAll did not drain");
		checksum += count;
	}
	return { checksum: checksum % 1000000007, operations };
}

runRuntimeGapCase("primordial-string-regexp-projections", run);
