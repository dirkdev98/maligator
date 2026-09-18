import { runRuntimeGapCase } from "../case-runner.mjs";

const MODULUS = 1_000_000_007;

function normalized(value) {
	const result = value % MODULUS;
	return result < 0 ? result + MODULUS : result;
}

function result(checksum, operations) {
	return { checksum: normalized(checksum), operations };
}

function predictableBranches(scale) {
	let checksum = 0;
	const operations = 1_000_000 * scale;
	for (let index = 0; index < operations; index++) {
		if ((index & 7) !== 0) checksum += index & 255;
		else checksum -= index & 63;
	}
	return result(checksum, operations);
}

runRuntimeGapCase("predictable-branches", predictableBranches);
