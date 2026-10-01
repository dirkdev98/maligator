import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const operations = 700 * scale;
	let checksum = 0;
	for (let round = 0; round < operations; round++) {
		const target = { seed: round & 255 };
		const key = round & 1 ? "left" : "right";
		const defined = Reflect.defineProperty(target, key, {
			value: round + 3,
			writable: true,
			enumerable: true,
			configurable: true,
		});
		Reflect.defineProperty(target, "fixed", { value: round + 7, configurable: false });
		const assigned = Reflect.set(target, key, round + 5);
		const value = Reflect.get(target, key);
		const keys = Reflect.ownKeys(target);
		const removed = Reflect.deleteProperty(target, key);
		const fixedRemoved = Reflect.deleteProperty(target, "fixed");
		if (
			!defined ||
			!assigned ||
			!removed ||
			fixedRemoved ||
			Reflect.get(target, key) !== undefined
		)
			throw new Error("reflective lifecycle failed");
		for (const ownKey of keys) checksum += ownKey.length;
		checksum += value + target.fixed + target.seed;
	}
	return { checksum: checksum % 1000000007, operations };
}

runRuntimeGapCase("primordial-reflect-property-lifecycle", run);
