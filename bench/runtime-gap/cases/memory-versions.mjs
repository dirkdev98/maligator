import { runRuntimeGapCase } from "../case-runner.mjs";

const MODULUS = 1_000_000_007;

function normalized(value) {
	const result = value % MODULUS;
	return result < 0 ? result + MODULUS : result;
}

function result(checksum, operations) {
	return { checksum: normalized(checksum), operations };
}

function memoryVersionsReplay(scale) {
	let checksum = 0;
	let operations = 0;
	for (let round = 0; round < 30 * scale; round++) {
		const versions = new Map();
		for (let event = 0; event < 45_000; event++) {
			const block = event & 1_023;
			let state = versions.get(block);
			if (state === undefined) {
				state = new Map();
				versions.set(block, state);
			}
			const location = (event * 17) & 511;
			const version = (state.get(location) ?? 0) + 1;
			state.set(location, version);
			checksum = (checksum + version + location) % MODULUS;
			operations += 3;
		}
	}
	return result(checksum, operations);
}

runRuntimeGapCase("memory-versions", memoryVersionsReplay);
