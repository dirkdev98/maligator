import { runRuntimeGapCase } from "../case-runner.mjs";

const lists = [
	Array.from({ length: 32 }, (_, i) => `${i}:` + "café東京".repeat(32)),
	Array.from({ length: 32 }, (_, i) => `${i}:` + "Alder".repeat(40)),
];

function run(scale) {
	const formatter = new Intl.ListFormat("en-US", { style: "long" });
	const operations = 50 * scale;
	let checksum = 0;
	for (let i = 0; i < operations; i++) {
		const result = formatter.format(lists[i & 1]);
		checksum = (checksum + result.length + result.charCodeAt(i % result.length)) | 0;
	}
	return { operations, checksum: checksum >>> 0 };
}

runRuntimeGapCase("intl-list-format-long", run);
