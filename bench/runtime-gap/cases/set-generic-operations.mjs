import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const keys = [];
	for (let index = 0; index < 128; index++) {
		keys.push(index, "member-" + index, { index }, BigInt(index));
	}
	let checksum = 0;
	let operations = 0;
	for (let round = 0; round < 80 * scale; round++) {
		const set = new Set();
		const cursor = set.values();
		for (const key of keys) {
			set.add(key);
			operations++;
		}
		for (let index = 0; index < keys.length; index++) {
			if (!set.has(keys[index])) throw new Error("generic member missing");
			operations++;
			checksum += index;
			if ((index & 7) === 0) {
				if (!set.delete(keys[index])) throw new Error("generic deletion failed");
				set.add(keys[index]);
				operations += 2;
			}
		}
		let count = 0;
		for (const key of cursor) {
			checksum +=
				typeof key === "number" ? key : typeof key === "bigint" ? Number(key) : 1;
			count++;
			operations++;
		}
		if (count !== keys.length || set.size !== count)
			throw new Error("generic pinned iteration failed");
	}
	return { checksum: checksum % 1000000007, operations };
}

runRuntimeGapCase("set-generic-operations", run);
