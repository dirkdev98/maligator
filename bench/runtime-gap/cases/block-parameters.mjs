import { runRuntimeGapCase } from "../case-runner.mjs";

const MODULUS = 1_000_000_007;

function normalized(value) {
	const result = value % MODULUS;
	return result < 0 ? result + MODULUS : result;
}

function result(checksum, operations) {
	return { checksum: normalized(checksum), operations };
}

function blockParameterReplay(scale) {
	const blocks = Array.from({ length: 1_024 }, (_, block) => ({
		parameters: Array.from({ length: 12 }, (_, index) => block * 16 + index),
		incoming: Array.from({ length: 3 }, (_, edge) =>
			Array.from({ length: 12 }, (_, index) => block * 48 + edge * 12 + index),
		),
	}));
	let checksum = 0;
	let operations = 0;
	for (let round = 0; round < 50 * scale; round++) {
		for (const block of blocks) {
			const parameter = block.parameters[(round + block.parameters.length) % 12];
			for (const incoming of block.incoming)
				checksum = (checksum + incoming[round % 12]) % MODULUS;
			checksum = (checksum + parameter) % MODULUS;
			operations += 4;
		}
	}
	return result(checksum, operations);
}

runRuntimeGapCase("block-parameters", blockParameterReplay);
