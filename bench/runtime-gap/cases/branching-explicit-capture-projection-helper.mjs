import { runRuntimeGapCase } from "../case-runner.mjs";

// Keep an out-of-line arithmetic helper so the measured seam is a call boundary.
function run(scale) {
	let bias = Number(process.argv[2] ?? "1") & 255;
	const project = (x, bias) => {
		if (x & 1) return x - bias;
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
	};

	let checksum = 0;
	const operations = 250_000 * scale;
	for (let index = 0; index < operations; index++) {
		bias = (bias + 1) & 255;
		checksum = (checksum + project(index & 255, bias)) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}

runRuntimeGapCase("branching-explicit-capture-projection-helper", run);
