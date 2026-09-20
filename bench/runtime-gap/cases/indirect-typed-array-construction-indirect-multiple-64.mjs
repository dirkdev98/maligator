import { runRuntimeGapCase } from "../case-runner.mjs";

function allocate(Construct, length) {
	return new Construct(length);
}

const secondary = allocate(Uint32Array, 1);
const retained = new Array(256);

function run(scale) {
	let checksum = 0;
	const operations = 20_000 * scale;
	for (let index = 0; index < operations; index++) {
		const value = allocate(Int32Array, 64);
		retained[index & 255] = value;
		checksum = (checksum + value.length) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}

function verify() {
	for (const value of retained) {
		if (!(value instanceof Int32Array) || value.length !== 64) {
			throw new Error("typed-array construction differs");
		}
	}
	if (!(secondary instanceof Uint32Array)) {
		throw new Error("secondary constructor path was not retained");
	}
}

runRuntimeGapCase("indirect-typed-array-construction-indirect-multiple-64", run, verify);
