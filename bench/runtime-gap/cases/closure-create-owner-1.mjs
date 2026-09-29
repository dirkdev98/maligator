import { runRuntimeGapCase } from "../case-runner.mjs";

function make(seed) {
	return (input) => {
		const value = input + seed;
		return () => value;
	};
}

function run(scale) {
	const seed = Number(process.argv[2] ?? "1") & 255;
	let factory = make(seed);
	const retained = new Array(64);
	globalThis.retainedCreatedClosures = retained;
	let checksum = 0;
	const operations = 100_000 * scale;
	for (let index = 0; index < operations; index++) {
		const closure = factory(index & 255);
		retained[index & 63] = closure;
		checksum = (checksum + closure()) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}

runRuntimeGapCase("closure-create-owner-1", run);
