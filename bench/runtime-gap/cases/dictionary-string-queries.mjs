import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const object = Object.create(null);
	const keys = [];
	const misses = [];
	const prefix = "dictionary-name-with-a-long-common-prefix-".repeat(3);
	for (let index = 0; index < 256; index++) {
		const suffix = String(index).padStart(3, "0");
		const key = prefix + "live-" + suffix;
		keys.push(key);
		misses.push(prefix + "miss-" + suffix);
		object[key] = index + 1;
	}
	delete object[keys[0]];
	object[keys[0]] = 1;
	let checksum = 0;
	let operations = 258;
	for (let round = 0; round < 1000 * scale; round++) {
		for (let index = 0; index < 256; index++) {
			const key = keys[index];
			const freshEqual = `${key}:${round}`.slice(0, key.length);
			const missing = misses[index];
			const freshMissing = `${missing}:${round}`.slice(0, missing.length);
			if (object[missing] !== undefined || object[freshMissing] !== undefined)
				throw new Error("dictionary miss returned a property");
			const value = object[key] + object[freshEqual];
			if (value !== 2 * (index + 1)) throw new Error("dictionary equal query failed");
			checksum += value;
			operations += 4;
		}
	}
	return { checksum: checksum % 1_000_000_007, operations };
}

runRuntimeGapCase("dictionary-string-queries", run);
