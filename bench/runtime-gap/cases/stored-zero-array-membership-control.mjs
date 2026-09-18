import { runRuntimeGapCase } from "../case-runner.mjs";

const MODULUS = 1_000_000_007;

function normalized(value) {
	const result = value % MODULUS;
	return result < 0 ? result + MODULUS : result;
}

function result(checksum, operations) {
	return { checksum: normalized(checksum), operations };
}

function storedZeroArrayMembershipControl(scale) {
	const values = [];
	for (let index = 0; index < 16_384; index += 2) values[index] = index & 255;
	for (let index = 1; index < 16_384; index += 2) values[index] = 0;
	const length = values.length;
	let checksum = 0;
	const rounds = 120 * scale;
	for (let round = 0; round < rounds; round++) {
		for (let index = 0; index < length; index++) {
			if (!(index in values)) checksum++;
		}
	}
	return result(checksum, length * rounds);
}

runRuntimeGapCase(
	"stored-zero-array-membership-control",
	storedZeroArrayMembershipControl,
);
