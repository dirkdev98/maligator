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
		const map = new Map();
		for (let index = 0; index < keys.length; index++) {
			map.set(keys[index], index + round);
			operations++;
		}
		for (let index = 0; index < keys.length; index++) {
			const value = map.get(queries[index]);
			if (value !== index + round) throw new Error("equal string value missing");
			checksum += value;
			operations++;
			if ((index & 3) === 0) {
				if (!map.delete(queries[index])) throw new Error("string deletion failed");
				map.set(keys[index], value);
				operations += 2;
			}
		}
		let count = 0;
		for (const [key, value] of map) {
			checksum += (key.length + value) * ++count;
			operations++;
		}
		if (count !== keys.length) throw new Error("string iteration lost pair");
	}
	return { checksum: checksum % 1000000007, operations };
}
runRuntimeGapCase("map-string-operations", run);
