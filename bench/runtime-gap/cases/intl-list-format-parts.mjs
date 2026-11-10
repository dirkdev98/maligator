import { runRuntimeGapCase } from "../case-runner.mjs";

const lists = [
	["Alder", "Birch", "Cedar"],
	["café", "Ångström", "東京"],
];

function run(scale) {
	const formatter = new Intl.ListFormat("en-US", { style: "long" });
	const operations = 1000 * scale;
	let checksum = 0;
	for (let i = 0; i < operations; i++) {
		const parts = formatter.formatToParts(lists[i & 1]);
		for (const part of parts) {
			checksum =
				(checksum + part.value.length + part.type.length + part.value.charCodeAt(0)) | 0;
		}
	}
	return { operations, checksum: checksum >>> 0 };
}

runRuntimeGapCase("intl-list-format-parts", run);
