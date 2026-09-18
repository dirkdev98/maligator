import { runRuntimeGapCase } from "../case-runner.mjs";

const MODULUS = 1_000_000_007;

function normalized(value) {
	const result = value % MODULUS;
	return result < 0 ? result + MODULUS : result;
}

function result(checksum, operations) {
	return { checksum: normalized(checksum), operations };
}

function loweringReplay(scale) {
	const instructions = Array.from({ length: 60_000 }, (_, index) => ({
		id: index,
		kind: index & 31,
		operands: [index === 0 ? 0 : index - 1, (index * 17) % (index + 1)],
	}));
	let checksum = 0;
	let operations = 0;
	for (let round = 0; round < 25 * scale; round++) {
		const operationsImage = new Uint16Array(instructions.length);
		const operandsImage = new Uint32Array(instructions.length * 2);
		for (const instruction of instructions) {
			operationsImage[instruction.id] = instruction.kind;
			operandsImage[instruction.id * 2] = instruction.operands[0];
			operandsImage[instruction.id * 2 + 1] = instruction.operands[1];
			checksum = (checksum + instruction.kind + instruction.operands[1]) % MODULUS;
			operations += 3;
		}
	}
	return result(checksum, operations);
}

runRuntimeGapCase("core-to-execution", loweringReplay);
