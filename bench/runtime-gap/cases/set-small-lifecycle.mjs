import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const choices = [
		[0, 1, 2, 3],
		["alpha", "beta", "gamma", "delta"],
		[{}, {}, {}, {}],
		[1, "key", null, 1n],
	];
	let checksum = 0;
	let operations = 0;
	for (let round = 0; round < 4000 * scale; round++) {
		const keys = choices[round & 3];
		const count = round % 5;
		const set = new Set();
		for (let index = 0; index < count; index++) {
			set.add(keys[index]);
			operations++;
		}
		for (let index = 0; index < count; index++) {
			if (!set.has(keys[index]) || !set.delete(keys[index]))
				throw new Error("small Set member lost");
			operations += 2;
			checksum += index + 1;
		}
		if (set.size !== 0) throw new Error("small Set deletion failed");
		operations++;
	}
	return { checksum: checksum % 1000000007, operations };
}

runRuntimeGapCase("set-small-lifecycle", run);
