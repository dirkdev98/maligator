import { runRuntimeGapCase } from "../case-runner.mjs";

function make(seed) {
	const value0 = seed;
	return function next() {
		const value1 = 1;
		return function next() {
			const value2 = 2;
			return function next() {
				const value3 = 3;
				return function next() {
					const value4 = 4;
					return function next() {
						const value5 = 5;
						return function next() {
							const value6 = 6;
							return (input) => () =>
								input + value0 + value1 + value2 + value3 + value4 + value5 + value6 - 21;
						};
					};
				};
			};
		};
	};
}

function run(scale) {
	const seed = Number(process.argv[2] ?? "1") & 255;
	let factory = make(seed);
	for (let level = 0; level < 6; level++) factory = factory();
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

runRuntimeGapCase("closure-create-owner-8", run);
