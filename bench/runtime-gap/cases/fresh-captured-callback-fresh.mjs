import { runRuntimeGapCase } from "../case-runner.mjs";

const seed = Number(process.argv[2] ?? "1") & 255;
const reportingEnabled = process.argv[4] === "report";
let currentValue = 0;
let reports = 0;

function invoke(callback) {
	return callback();
}

function invokeWithReporting(callback) {
	const result = callback();
	if (reportingEnabled) reports = (reports + result) | 0;
	return result;
}

function reusedCallback() {
	return currentValue + 1;
}

function run(scale) {
	let checksum = 0;
	const operations = 250_000 * scale;
	for (let index = 0; index < operations; index++) {
		const value = (seed + index) & 255;

		checksum = (checksum + invoke(() => value + 1)) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}

function verify() {
	if (!reportingEnabled && reports !== 0) throw new Error("disabled reporting ran");
}

runRuntimeGapCase("fresh-captured-callback-fresh", run, verify);
