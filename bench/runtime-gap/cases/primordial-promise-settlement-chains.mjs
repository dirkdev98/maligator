import { runAsyncRuntimeGapCase } from "../async-case-runner.mjs";

async function run(scale) {
	const operations = 180 * scale;
	let checksum = 0;
	let finalized = 0;
	for (let round = 0; round < operations; round++) {
		const base = round & 255;
		const fulfilled = Promise.resolve(base)
			.then((value) => value * 2 + 3)
			.finally(() => {
				finalized++;
			});
		const rejected = Promise.reject(base + 5)
			.finally(() => {
				finalized++;
			})
			.catch((reason) => reason + 9);
		const left = await fulfilled;
		const right = await rejected;
		if (left !== base * 2 + 3 || right !== base + 14)
			throw new Error("promise chain result failed");
		checksum += left + right;
	}
	if (finalized !== operations * 2) throw new Error("finally did not settle");
	return { checksum: (checksum + finalized) % 1000000007, operations };
}

runAsyncRuntimeGapCase("primordial-promise-settlement-chains", run);
