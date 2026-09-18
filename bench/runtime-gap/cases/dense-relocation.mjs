import { runRuntimeGapCase } from "../case-runner.mjs";

const MODULUS = 1_000_000_007;

function normalized(value) {
	const result = value % MODULUS;
	return result < 0 ? result + MODULUS : result;
}

function result(checksum, operations) {
	return { checksum: normalized(checksum), operations };
}

function denseRelocationReplay(scale) {
	const relocation = new Uint32Array(32_768);
	const operands = new Uint32Array(131_072);
	let checksum = 0;
	for (let round = 0; round < 30 * scale; round++) {
		for (let index = 0; index < relocation.length; index++)
			relocation[index] = index ^ round;
		for (let index = 0; index < operands.length; index++) {
			operands[index] = relocation[(index * 17) & 32_767];
			checksum = (checksum + operands[index]) % MODULUS;
		}
	}
	return result(checksum, (relocation.length + operands.length) * 30 * scale);
}

runRuntimeGapCase("dense-relocation", denseRelocationReplay);
