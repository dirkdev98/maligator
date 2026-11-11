import { runRuntimeGapCase } from "../case-runner.mjs";

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const GOLDEN_GAMMA = 0x9e3779b97f4a7c15n;

// FNV-1a 64 as BigInt hashing libraries write it.
function fnv1a64(bytes) {
	let hash = FNV_OFFSET;
	for (let index = 0; index < bytes.length; index++) {
		hash ^= BigInt(bytes[index]);
		hash = BigInt.asUintN(64, hash * FNV_PRIME);
	}
	return hash;
}

// splitmix64's output mix, the seeding generator behind xoshiro.
function splitmix64(state) {
	let mixed = BigInt.asUintN(64, (state ^ (state >> 30n)) * 0xbf58476d1ce4e5b9n);
	mixed = BigInt.asUintN(64, (mixed ^ (mixed >> 27n)) * 0x94d049bb133111ebn);
	return mixed ^ (mixed >> 31n);
}

function run(scale) {
	const records = 200 * scale;
	const bytes = new Uint8Array(32);
	let seed = 0n;
	let checksum = 0;
	for (let record = 0; record < records; record++) {
		for (let index = 0; index < bytes.length; index++)
			bytes[index] = (record * 31 + index * 7) & 255;
		const hash = fnv1a64(bytes);
		seed = BigInt.asUintN(64, seed + GOLDEN_GAMMA);
		const random = Number(splitmix64(seed) >> 11n) / 9007199254740992;
		checksum =
			(checksum + Number(hash & 0xffffn) + Math.floor(random * 1000)) % 1000000007;
	}
	return { checksum, operations: records };
}

runRuntimeGapCase("bigint-hash-consumer", run);
