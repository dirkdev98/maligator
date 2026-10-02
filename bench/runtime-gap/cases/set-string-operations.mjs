import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const keys = [];
	const queries = [];
	for (let index = 0; index < 256; index++) {
		keys.push("member-" + index + "-" + "x".repeat(64));
		queries.push(["member", index, "x".repeat(64)].join("-"));
	}
	let checksum = 0;
	let operations = 0;
	for (let round = 0; round < 80 * scale; round++) {
		const set = new Set(keys);
		operations += keys.length;
		for (let index = 0; index < keys.length; index++) {
			if (!set.has(queries[index])) throw new Error("equal string missing");
			checksum += index;
			operations++;
			if ((index & 3) === 0) {
				if (!set.delete(queries[index])) throw new Error("string deletion failed");
				set.add(keys[index]);
				operations += 2;
			}
		}
		let count = 0;
		for (const key of set) {
			checksum += key.length * ++count;
			operations++;
		}
		if (count !== keys.length) throw new Error("string Set iteration lost member");
	}
	return { checksum: checksum % 1000000007, operations };
}

runRuntimeGapCase("set-string-operations", run);
