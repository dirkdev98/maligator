import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const left = Array.from({ length: 12 }, (_, index) => index);
	const right = Array.from({ length: 12 }, (_, index) => index + 20);
	const operations = 1000 * scale;
	let checksum = 0;
	for (let round = 0; round < operations; round++) {
		const merged = left.concat(right, [round & 255]);
		const removed = merged.splice(5, 3, round & 31, (round + 1) & 31);
		const reversed = merged.reverse();
		if (
			reversed !== merged ||
			merged.length !== 24 ||
			removed.length !== 3 ||
			removed[0] !== 5 ||
			removed[2] !== 7 ||
			merged[0] !== (round & 255)
		)
			throw new Error("concat/splice mismatch");
		for (let index = 0; index < merged.length; index++)
			checksum += merged[index] * (index + 1);
		for (let index = 0; index < removed.length; index++) checksum += removed[index];
	}
	return { checksum: checksum % 1000000007, operations };
}

runRuntimeGapCase("primordial-array-concat-splice", run);
