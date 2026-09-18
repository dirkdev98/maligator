import { runRuntimeGapCase } from "../case-runner.mjs";

const MODULUS = 1_000_000_007;

function normalized(value) {
	const result = value % MODULUS;
	return result < 0 ? result + MODULUS : result;
}

function result(checksum, operations) {
	return { checksum: normalized(checksum), operations };
}

function canonicalRootsReplay(scale) {
	const parents = Uint32Array.from({ length: 131_072 }, (_, index) =>
		index === 0 || (index & 7) === 0 ? index : index - 1,
	);
	let checksum = 0;
	let operations = 0;
	for (let round = 0; round < 45 * scale; round++) {
		for (let value = 0; value < parents.length; value++) {
			let root = value;
			while (parents[root] !== root) {
				root = parents[root];
				operations++;
			}
			parents[value] = root;
			checksum = (checksum + root) % MODULUS;
			operations++;
		}
	}
	return result(checksum, operations);
}

runRuntimeGapCase("canonical-roots", canonicalRootsReplay);
