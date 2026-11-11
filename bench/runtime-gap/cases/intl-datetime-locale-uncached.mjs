import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const operations = 1000 * scale;
	let checksum = 0;
	for (let i = 0; i < operations; i++) {
		const epoch = 1700000000000 + (i % 27) * 86400000;
		const text = new Date(epoch).toLocaleDateString("fr-FR", { dateStyle: "medium" });
		checksum = (checksum + text.length + text.charCodeAt(i % text.length)) | 0;
	}
	return { operations, checksum: checksum >>> 0 };
}

runRuntimeGapCase("intl-datetime-locale-uncached", run);
