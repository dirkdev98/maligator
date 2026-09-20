import { runRuntimeGapCase } from "../case-runner.mjs";

const seed = Number(process.argv[2] ?? "1") & 255;
const reportingEnabled = process.argv[4] === "report";
const state = { completed: 0 };

function callback(value) {
	return (value + seed) & 255;
}

function invoke(value) {
	let result;
	try {
		result = callback(value);
	} finally {
		if (reportingEnabled) state.completed++;
	}
	return result;
}

function run(scale) {
	let checksum = 0;
	const operations = 250_000 * scale;
	for (let index = 0; index < operations; index++) {
		checksum = (checksum + invoke(index & 255)) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}

runRuntimeGapCase("try-finally-call-no-throw-disabled-finally", run);
