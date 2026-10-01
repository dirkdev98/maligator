import { runAsyncRuntimeGapCase } from "../async-case-runner.mjs";

async function run(scale) {
	const operations = 160 * scale;
	let checksum = 0;
	for (let round = 0; round < operations; round++) {
		const base = round & 255;
		const race =
			round & 1
				? Promise.race([Promise.reject(base + 1), Promise.resolve(base + 4)]).catch(
						(reason) => reason + 11,
					)
				: Promise.race([
						Promise.resolve(base).then((value) => value + 1),
						Promise.resolve(base + 7),
					]);
		const any =
			round & 1
				? Promise.any([Promise.reject(base + 2), Promise.reject(base + 5)]).catch(
						(error) => {
							if (error.errors.length !== 2)
								throw new Error("any rejection count failed");
							return error.errors[0] + error.errors[1];
						},
					)
				: Promise.any([Promise.reject(base + 3), Promise.resolve(base + 9)]);
		const first = await race;
		const second = await any;
		const expectedFirst = round & 1 ? base + 12 : base + 7;
		const expectedSecond = round & 1 ? base * 2 + 7 : base + 9;
		if (first !== expectedFirst || second !== expectedSecond)
			throw new Error("first settlement failed");
		checksum += first + second;
	}
	return { checksum: checksum % 1000000007, operations };
}

runAsyncRuntimeGapCase("primordial-promise-race-and-any", run);
