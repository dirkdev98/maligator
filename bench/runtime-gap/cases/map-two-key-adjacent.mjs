import { runRuntimeGapCase } from "../case-runner.mjs";
const counts = new Map();
for (let key = 0; key < 256; key++) counts.set(key, key);
function run(scale) {
	let checksum = 0;
	const iterations = 65536 * scale;
	for (let index = 0; index < iterations; index++) {
		const firstKey = index & 255,
			secondKey = (index + 37) & 255;
		const first = counts.get(firstKey);
		counts.set(firstKey, (first + 1) & 255);
		const second = counts.get(secondKey);
		counts.set(secondKey, (second + 1) & 255);
		checksum = (checksum + first + second) | 0;
	}
	return { checksum: checksum >>> 0, operations: iterations * 4 };
}
function verify() {
	for (let key = 0; key < 256; key++)
		if (counts.get(key) !== key) throw new Error("Map state changed");
}
runRuntimeGapCase("map-two-key-adjacent", run, verify);
