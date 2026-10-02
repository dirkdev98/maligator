import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const keys = [];
	const map = new Map();
	for (let index = 0; index < 8; index++) {
		const key = "member-" + index + "-" + "x".repeat(64);
		keys.push(key);
		map.set(key, index);
	}
	let checksum = 0;
	let operations = 8;
	for (let round = 0; round < 20_000 * scale; round++) {
		const index = round & 7;
		const prefix = keys[index];
		for (let burst = 0; burst < 16; burst++) {
			const query = `${prefix}:${round}:${burst}`.slice(0, prefix.length);
			const value = map.get(query);
			if (value !== index) throw new Error("fresh equal string value missing");
			checksum += value + query.length;
			operations++;
		}
	}
	return { checksum: checksum % 1_000_000_007, operations };
}

runRuntimeGapCase("map-string-hint-equal", run);
