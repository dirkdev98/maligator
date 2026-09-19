import { runRuntimeGapCase } from "../case-runner.mjs";

const seed = Number(process.argv[2] ?? "1") & 255;
const keys = Array.from({ length: 256 }, (_, index) => ({ index, seed }));
const initial = keys.map((_, index) => (index + seed) & 255);
const left = new Map(keys.map((key, index) => [key, initial[index]]));
const right = new Map(keys.map((key, index) => [key, initial[index]]));

function run(scale) {
	let checksum = 0;
	const iterations = 65_536 * scale;
	for (let index = 0; index < iterations; index++) {
		const key = keys[index & 255];
		const leftValue = left.get(key);
		left.set(key, (leftValue + 1) & 255);
		const rightValue = right.get(key);
		right.set(key, (rightValue + 1) & 255);
		checksum = (checksum + leftValue + rightValue) | 0;
	}
	return { checksum: checksum >>> 0, operations: iterations * 4 };
}

function verify() {
	for (let index = 0; index < keys.length; index++) {
		if (
			left.get(keys[index]) !== initial[index] ||
			right.get(keys[index]) !== initial[index]
		) {
			throw new Error("Map contents did not return to their prepared state");
		}
	}
}

runRuntimeGapCase("map-get-set-adjacent", run, verify);
