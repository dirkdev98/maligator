import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const operations = 550 * scale;
	let checksum = 0;
	for (let round = 0; round < operations; round++) {
		const values = new Set();
		for (let index = 0; index < 16; index++) {
			const value = (index * 3 + round) & 31;
			values.add(value);
			if ((index & 3) === 0) values.add(value);
		}
		const key = round & 31;
		const present = values.has(key);
		const removed = values.delete(key);
		const missing = values.has(63);
		let callbackSum = 0;
		let callbackCount = 0;
		values.forEach((value, key, owner) => {
			const position = ++callbackCount;
			if (value !== ((position * 3 + round) & 31) || key !== value || owner !== values)
				throw new Error("set callback order mismatch");
			callbackSum += value * position;
		});
		let iteratorSum = 0;
		let count = 0;
		for (const value of values.values()) {
			const position = ++count;
			if (value !== ((position * 3 + round) & 31))
				throw new Error("set iterator order mismatch");
			iteratorSum += value * position;
		}
		const size = values.size;
		values.clear();
		if (
			!present ||
			!removed ||
			missing ||
			values.size !== 0 ||
			callbackSum !== iteratorSum ||
			count !== 15 ||
			callbackCount !== 15 ||
			size !== 15
		)
			throw new Error("set lifecycle failed");
		checksum += callbackSum + iteratorSum * 3 + size + (round & 31);
	}
	return { checksum: checksum % 1000000007, operations };
}

runRuntimeGapCase("primordial-set-membership-and-drain", run);
