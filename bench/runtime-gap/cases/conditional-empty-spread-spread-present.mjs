import { runRuntimeGapCase } from "../case-runner.mjs";

const seed = Number(process.argv[2] ?? "1") & 255;
const retained = new Array(256);

function run(scale) {
	let checksum = 0;
	const operations = 50_000 * scale;
	for (let index = 0; index < operations; index++) {
		const value = (seed + index) & 255;
		const previous = (seed + index - 1) & 255;
		const record = { value, ...(previous === undefined ? {} : { previous }) };
		retained[index & 255] = record;
		checksum = (checksum + value + (previous === undefined ? 0 : 1)) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}

function verify() {
	for (const record of retained) {
		if (record === undefined) throw new Error("record was not retained");
		if ("previous" in record !== (record.previous !== undefined)) {
			throw new Error("conditional spread changed property absence");
		}
	}
}

runRuntimeGapCase("conditional-empty-spread-spread-present", run, verify);
