import { runRuntimeGapCase } from "../case-runner.mjs";

// Match the projection controls while exercising the captured declaration alias.
function run(scale) {
	let bias = Number(process.argv[2] ?? "1") & 255;
	function project(x) {
		return (
			x * 1 +
			bias +
			(x * 2 + bias) +
			(x * 3 + bias) +
			(x * 4 + bias) +
			(x * 5 + bias) +
			(x * 6 + bias) +
			(x * 7 + bias) +
			(x * 8 + bias) +
			(x * 9 + bias) +
			(x * 10 + bias) +
			(x * 11 + bias) +
			(x * 12 + bias) +
			(x * 13 + bias) +
			(x * 14 + bias) +
			(x * 15 + bias) +
			(x * 16 + bias) +
			(x * 17 + bias) +
			(x * 18 + bias) +
			(x * 19 + bias) +
			(x * 20 + bias)
		);
	}
	globalThis.runtimeGapEscapedProjection = project;
	let checksum = 0;
	const operations = 250_000 * scale;
	for (let index = 0; index < operations; index++) {
		bias = (bias + 1) & 255;
		checksum = (checksum + project(index & 255)) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}

runRuntimeGapCase("declared-capture-projection-helper", run);
