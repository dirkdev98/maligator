import { runRuntimeGapCase } from "../case-runner.mjs";

let value = "";
for (let index = 0; index < 512; index++) value += "aaaaaaaaaaaaaaaa";
const needle = "a".repeat(510) + "ba";
const hit = value + needle;

function run(scale) {
	let checksum = 0;
	const operations = 32 * scale;
	for (let index = 0; index < operations; index++) {
		checksum += value.indexOf(needle) + value.lastIndexOf(needle);
		checksum += hit.indexOf(needle) + hit.lastIndexOf(needle);
	}
	return { checksum, operations: operations * 4 };
}

runRuntimeGapCase("string-search-repetitive", run);
