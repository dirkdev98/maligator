import { runRuntimeGapCase } from "../case-runner.mjs";

const MODULUS = 1_000_000_007;

function normalized(value) {
	const result = value % MODULUS;
	return result < 0 ? result + MODULUS : result;
}

function result(checksum, operations) {
	return { checksum: normalized(checksum), operations };
}

function valueKindReplay(scale) {
	const kinds = new Uint16Array(65_536);
	const operands = Uint32Array.from(kinds, (_, index) => (index * 17) & 65_535);
	let checksum = 0;
	let operations = 0;
	for (let round = 0; round < 30 * scale; round++) {
		let changed = true;
		for (let pass = 0; pass < 4 && changed; pass++) {
			changed = false;
			for (let index = 1; index < kinds.length; index++) {
				const kind = kinds[operands[index]] | (1 << ((index + round) & 7));
				if (kind !== kinds[index]) {
					kinds[index] = kind;
					changed = true;
				}
				checksum = (checksum + kind) % MODULUS;
				operations++;
			}
		}
	}
	return result(checksum, operations);
}

runRuntimeGapCase("value-kinds", valueKindReplay);
