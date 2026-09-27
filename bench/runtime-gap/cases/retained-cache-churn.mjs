import { runRuntimeGapCase } from "../case-runner.mjs";

const SIZE = 8_192;
const MODULUS = 1_000_000_007;

function record(key, version) {
	return {
		key,
		version,
		payload: [key & 255, version, (key ^ version) & 1_023],
		meta: { key, version },
	};
}

function retainedCacheChurn(scale) {
	const cache = new Map();
	for (let key = 0; key < SIZE; key++) cache.set(key, record(key, 0));
	let checksum = 0;
	let operations = 0;
	for (let round = 0; round < 12 * scale; round++) {
		for (let index = 0; index < 16_384; index++) {
			const key = (index * 73 + round * 97) & (SIZE - 1);
			const previous = cache.get(key);
			if (previous === undefined) throw new Error("cache entry disappeared");
			if ((index & 1) === 0) {
				const next = record(key, previous.version + 1);
				cache.set(key, next);
				checksum += previous.payload[2] + next.meta.version;
			} else {
				checksum += previous.payload[0] + previous.meta.version;
			}
			operations++;
			if ((operations & 1_023) === 0) checksum %= MODULUS;
		}
		if ((round & 3) === 3) {
			for (let key = 0; key < SIZE; key += 4) {
				const previous = cache.get(key);
				if (previous === undefined) throw new Error("cache wave lost an entry");
				checksum += previous.version;
				cache.delete(key);
			}
			for (let key = 0; key < SIZE; key += 4) {
				cache.set(key, record(key, round + 1));
			}
		}
		if (cache.size !== SIZE) throw new Error("cache size changed");
	}
	for (const value of cache.values()) {
		checksum += value.key + value.version + value.payload[1] + value.meta.key;
		operations++;
		if ((operations & 1_023) === 0) checksum %= MODULUS;
	}
	return { checksum: checksum % MODULUS, operations };
}

runRuntimeGapCase("retained-cache-churn", retainedCacheChurn);
