import { runRuntimeGapCase } from "../case-runner.mjs";

const MODULUS = 1_000_000_007;

function normalized(value) {
	const result = value % MODULUS;
	return result < 0 ? result + MODULUS : result;
}

function result(checksum, operations) {
	return { checksum: normalized(checksum), operations };
}

function tryWithoutThrow(scale) {
	let checksum = 0;
	const operations = 700_000 * scale;
	for (let index = 0; index < operations; index++) {
		try {
			checksum += (index * 3) & 255;
		} finally {
			checksum ^= index & 7;
		}
	}
	return result(checksum, operations);
}

runRuntimeGapCase("try-without-throw", tryWithoutThrow);
