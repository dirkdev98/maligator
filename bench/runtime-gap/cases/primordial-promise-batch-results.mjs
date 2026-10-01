import { runAsyncRuntimeGapCase } from "../async-case-runner.mjs";

async function run(scale) {
	const operations = 160 * scale;
	let checksum = 0;
	for (let round = 0; round < operations; round++) {
		const base = round & 255;
		const delayedFirst = Promise.resolve(base)
			.then((value) => value + 1)
			.then((value) => value - 1);
		const values = await Promise.all([
			delayedFirst,
			base + 1,
			Promise.resolve(base + 2).then((value) => value + 1),
		]);
		const settled = await Promise.allSettled([
			Promise.resolve(base + 3).then((value) => value + 1),
			Promise.reject(base + 7),
		]);
		if (
			settled.length !== 2 ||
			settled[0].status !== "fulfilled" ||
			settled[0].value !== base + 4 ||
			settled[1].status !== "rejected" ||
			settled[1].reason !== base + 7 ||
			values.length !== 3 ||
			values[0] !== base ||
			values[1] !== base + 1 ||
			values[2] !== base + 3
		)
			throw new Error("batch settlement failed");
		for (let index = 0; index < values.length; index++)
			checksum += values[index] * (index + 1);
		checksum += settled[0].value * 2 + settled[1].reason * 3;
	}
	return { checksum: checksum % 1000000007, operations };
}

runAsyncRuntimeGapCase("primordial-promise-batch-results", run);
