import { runRuntimeGapCase } from "../case-runner.mjs";

const seed = Number(process.argv[2] ?? "1") & 255;
const arrays = Array.from({ length: 32 }, (_, arrayIndex) =>
	Array.from({ length: 8 }, (_, index) => (seed + arrayIndex + index) & 255),
);
const selected = 7;

function run(scale) {
	let checksum = 0;
	const operations = 50_000 * scale;
	for (let index = 0; index < operations; index++) {
		const available = arrays[index & 31];
		const value = available.splice(selected, 1)[0];
		available.splice(selected, 0, value);
		checksum = (checksum + value) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}

function verify() {
	for (const available of arrays) {
		if (available.length !== 8) throw new Error("array was not restored");
	}
}

runRuntimeGapCase("tiny-splice-extract-splice-8-last", run, verify);
