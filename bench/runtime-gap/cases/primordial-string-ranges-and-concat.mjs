import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const operations = 1700 * scale;
	let checksum = 0;
	for (let round = 0; round < operations; round++) {
		const text = "prefix-é-" + round + "-suffix";
		const offset = 1 + (round & 3);
		const tail = text.slice(-8, -offset);
		const middle = text.substring(8, offset);
		const joined = middle.concat(":", tail, ":", round & 15);
		if (tail.length !== 8 - offset || middle.length !== 8 - offset)
			throw new Error("string range failed");
		for (let index = 0; index < joined.length; index++)
			checksum += joined.charCodeAt(index) * ((index & 3) + 1);
	}
	return { checksum: checksum % 1000000007, operations };
}

runRuntimeGapCase("primordial-string-ranges-and-concat", run);
