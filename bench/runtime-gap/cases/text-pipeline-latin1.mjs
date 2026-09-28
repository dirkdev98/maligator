import { runRuntimeGapCase } from "../case-runner.mjs";

const records = {};
const paths = [];
for (let index = 0; index < 32; index++) {
	const key =
		"record-caf\u00e9\u00ff-" +
		String(index).padStart(3, "0") +
		"-abcdefghijklmnopqrstuv";
	records[key] = {
		title: "Cr\u00e8me br\u00fbl\u00e9e \u00e0 S\u00e3o Paulo " + index,
		detail: 'quoted "caf\u00e9"\\stock\t\u00ff\0' + index,
		amount: index * 17 + 3,
	};
	paths.push("/records/" + key + "/summary");
}
const source = JSON.stringify({ records, paths: paths.concat(paths) });

function run(scale) {
	let checksum = 5381;
	const operations = 64 * scale;
	for (let batch = 0; batch < operations; batch++) {
		const document = JSON.parse(source);
		const summaries = [];
		for (let index = 0; index < document.paths.length; index++) {
			const key = document.paths[index].slice(9, -8);
			const record = document.records[key];
			summaries.push({
				key,
				label: [record.title, record.detail, String(record.amount)]
					.join(" | ")
					.replace("\t", " "),
				total: record.amount + index,
			});
		}
		const output = JSON.stringify(summaries);
		for (let offset = 0; offset < output.length; offset++) {
			checksum = ((checksum << 5) + checksum + output.charCodeAt(offset)) | 0;
		}
	}
	return { checksum: checksum >>> 0, operations };
}

runRuntimeGapCase("text-pipeline-latin1", run);
