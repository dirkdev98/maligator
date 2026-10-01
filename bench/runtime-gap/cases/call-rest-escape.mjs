import { runRuntimeGapCase } from "../case-runner.mjs";

function restList(...values) {
	return values;
}

// Returning the rest array prevents scalar replacement and one-use spread forwarding.
const target = Reflect.get({ target: restList }, process.argv[4] ?? "target");
if (typeof target !== "function") throw new Error("unknown call target");

function run(scale) {
	const operations = 100_000 * scale;
	let checksum = 0;
	for (let index = 0; index < operations; index++) {
		const values = target(index & 31, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 7);
		const selected = (index & 1) * 15;
		checksum = (checksum + values[selected] + values[15 - selected] + values.length) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}

function verify({ checksum, operations }) {
	if (checksum !== ((operations / 32) * 1232) >>> 0) {
		throw new Error("escaped rest checksum mismatch");
	}
}

runRuntimeGapCase("call-rest-escape", run, verify);
