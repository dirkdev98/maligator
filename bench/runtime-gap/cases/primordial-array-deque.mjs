import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const values = Array.from({ length: 16 }, (_, index) => index);
	const operations = 3000 * scale;
	let checksum = 0;
	for (let round = 0; round < operations; round++) {
		const tailLength = values.push(round & 255, (round + 1) & 255);
		const popped = values.pop();
		const shifted = values.shift();
		const headLength = values.unshift((round * 3) & 255);
		const restored = values.pop();
		if (
			tailLength !== 18 ||
			headLength !== 17 ||
			values.length !== 16 ||
			popped !== ((round + 1) & 255) ||
			restored !== (round & 255)
		)
			throw new Error("deque mutation mismatch");
		checksum += popped + shifted + restored + values[0];
	}
	return { checksum: checksum % 1000000007, operations };
}

runRuntimeGapCase("primordial-array-deque", run);
