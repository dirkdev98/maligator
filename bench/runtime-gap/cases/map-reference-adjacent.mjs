import { runRuntimeGapCase } from "../case-runner.mjs";
const entries = new Map();
const keys = [],
	values = [];
for (let index = 0; index < 256; index++) {
	const key = index & 1 ? BigInt(index) : `retained-entry-${index}`;
	keys.push(key);
	values.push({ index });
	entries.set(key, values[index]);
}
function run(scale) {
	let checksum = 0;
	const iterations = 65536 * scale;
	for (let index = 0; index < iterations; index++) {
		const firstKey = keys[index & 255],
			secondKey = keys[(index + 37) & 255];
		const first = entries.get(firstKey);
		entries.set(firstKey, values[(first.index + 1) & 255]);
		const second = entries.get(secondKey);
		entries.set(secondKey, values[(second.index + 1) & 255]);
		checksum = (checksum + first.index + second.index) | 0;
	}
	return { checksum: checksum >>> 0, operations: iterations * 4 };
}
function verify() {
	for (let index = 0; index < keys.length; index++)
		if (entries.get(keys[index]) !== values[index])
			throw new Error("Map reference changed");
}
runRuntimeGapCase("map-reference-adjacent", run, verify);
