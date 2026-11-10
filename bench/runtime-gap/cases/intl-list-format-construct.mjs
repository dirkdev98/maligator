import { runRuntimeGapCase } from "../case-runner.mjs";

const lists = [
	["Alder", "Birch", "Cedar"],
	["café", "Ångström", "東京"],
];

function run(scale) {
	const operations = 1000 * scale;
	let checksum = 0;
	for (let i = 0; i < operations; i++) {
		const formatter = new Intl.ListFormat("en-US", { style: "long" });
		const result = formatter.format(lists[i & 1]);
		checksum = (checksum + result.length + result.charCodeAt(i % result.length)) | 0;
	}
	return { operations, checksum: checksum >>> 0 };
}

runRuntimeGapCase("intl-list-format-construct", run);
