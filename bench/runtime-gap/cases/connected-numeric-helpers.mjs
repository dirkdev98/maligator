import { runRuntimeGapCase } from "../case-runner.mjs";

// A numeric representation must cross all three escaped helper boundaries.
function leaf(x, bias) {
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
		(x * 20 + bias) +
		(x * 21 + bias) +
		(x * 22 + bias) +
		(x * 23 + bias) +
		(x * 24 + bias)
	);
}

function helper(x, bias) {
	if (x < 0) return leaf(-x, bias) - bias;
	return leaf(x, bias) + bias;
}

function visitor(x, bias) {
	let sum = 0;
	for (let step = 0; step < 3; step++) sum += helper(x + step, bias);
	return sum;
}

function run(scale) {
	let bias = Number(process.argv[2] ?? "1") & 255;
	// Preserve every helper's observable identity and the three call boundaries.
	globalThis.__connected_leaf = leaf;
	globalThis.__connected_helper = helper;
	globalThis.__connected_visitor = visitor;

	let checksum = 0;
	const operations = 100_000 * scale;
	for (let index = 0; index < operations; index++) {
		bias = (bias + 1) & 255;
		checksum = (checksum + visitor((index & 255) - 128, bias)) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}

globalThis.__connected_run = run;
runRuntimeGapCase("connected-numeric-helpers", run);
