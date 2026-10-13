import { runRuntimeGapCase } from "../case-runner.mjs";

const entries = new Map();
for (let key = 0; key < 256; key++) entries.set(key, key);
function update(map, firstKey, secondKey, change) {
	let first, second;
	try {
		first = map.get(firstKey);
		second = map.get(secondKey);
		if (change) {
			const difference = second - first;
			first += difference > 0 ? 1 : -1;
		} else second += 1;
		map.set(firstKey, first & 255);
		map.set(secondKey, second & 255);
	} catch (error) {
		throw error;
	}
	return first + second;
}
function run(scale) {
	let checksum = 0;
	const iterations = 65536 * scale;
	for (let index = 0; index < iterations; index++)
		checksum =
			(checksum + update(entries, index & 255, (index + 37) & 255, (index & 3) === 0)) |
			0;
	return { checksum: checksum >>> 0, operations: iterations * 4 };
}
function verify() {
	if (entries.size !== 256) throw new Error("Map size changed");
	for (const value of entries.values())
		if (!Number.isInteger(value) || value < 0 || value > 255)
			throw new Error("Map update range");
}
runRuntimeGapCase("map-entry-control-flow", run, verify);
