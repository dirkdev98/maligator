import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const map = new Map();
	for (let index = 0; index < 16; index++) map.set(index, index * 3);
	const operations = 1000 * scale;
	let checksum = 0;
	for (let round = 0; round < operations; round++) {
		map.set(round & 15, round & 255);
		let entries = 0;
		let keys = 0;
		let values = 0;
		let visited = 0;
		let position = 0;
		for (const [key, value] of map.entries()) entries += (key + value) * ++position;
		position = 0;
		for (const key of map.keys()) keys += key * ++position;
		position = 0;
		for (const value of map.values()) values += value * ++position;
		position = 0;
		map.forEach((value, key) => {
			visited += (key + value) * ++position;
		});
		if (keys !== 1360 || entries !== keys + values || visited !== entries)
			throw new Error("map iteration mismatch");
		checksum += entries + keys + values + visited;
	}
	return { checksum: checksum % 1000000007, operations };
}

runRuntimeGapCase("primordial-map-traversal", run);
