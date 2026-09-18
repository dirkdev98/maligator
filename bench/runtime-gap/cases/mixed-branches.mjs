import { runRuntimeGapCase } from "../case-runner.mjs";

const MODULUS = 1_000_000_007;

function normalized(value) {
	const result = value % MODULUS;
	return result < 0 ? result + MODULUS : result;
}

function result(checksum, operations) {
	return { checksum: normalized(checksum), operations };
}

function mixedBranches(scale) {
	let checksum = 0;
	let state = 0x12345678;
	const operations = 800_000 * scale;
	for (let index = 0; index < operations; index++) {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		if ((state & 1) === 0) checksum += index & 255;
		else checksum -= index & 127;
	}
	return result(checksum, operations);
}

runRuntimeGapCase("mixed-branches", mixedBranches);
