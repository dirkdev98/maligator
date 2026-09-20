import { runRuntimeGapCase } from "../case-runner.mjs";

const seed = Number(process.argv[2] ?? "1") & 255;
const arrays = Array.from({ length: 32 }, (_, arrayIndex) =>
	Array.from({ length: 3 }, (_, index) => (seed + arrayIndex + index) & 255),
);
const selected = 2;

function run(scale) {
	let checksum = 0;
	const operations = 50_000 * scale;
	for (let index = 0; index < operations; index++) {
		const available = arrays[index & 31];
		const value = available[selected];
		for (let cursor = selected; cursor < available.length - 1; cursor++) {
			available[cursor] = available[cursor + 1];
		}
		available.pop();
		for (let cursor = available.length; cursor > selected; cursor--) {
			available[cursor] = available[cursor - 1];
		}
		available[selected] = value;
		checksum = (checksum + value) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}

function verify() {
	for (const available of arrays) {
		if (available.length !== 3) throw new Error("array was not restored");
	}
}

runRuntimeGapCase("tiny-splice-extract-indexed-3-last", run, verify);
