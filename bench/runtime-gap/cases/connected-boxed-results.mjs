import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	let bias = Number(process.argv[2] ?? "1") & 255;
	const leaf = function resultOnlyLeaf(input) {
		const x = +input;
		return (
			x * 1 +
			x * 2 +
			x * 3 +
			x * 4 +
			x * 5 +
			x * 6 +
			x * 7 +
			x * 8 +
			x * 9 +
			x * 10 +
			x * 11 +
			x * 12 +
			x * 13 +
			x * 14 +
			x * 15 +
			x * 16 +
			x * 17 +
			x * 18 +
			x * 19 +
			x * 20 +
			x * 21 +
			x * 22 +
			x * 23 +
			x * 24 +
			x * 25 +
			x * 26 +
			x * 27 +
			x * 28 +
			x * 29 +
			x * 30 +
			x * 31 +
			x * 32 +
			x * 33 +
			x * 34 +
			x * 35 +
			x * 36 +
			x * 37 +
			x * 38 +
			x * 39 +
			x * 40 +
			x * 41 +
			x * 42 +
			x * 43 +
			x * 44 +
			x * 45 +
			x * 46 +
			x * 47 +
			x * 48 +
			+bias
		);
	};
	const visitor = function resultOnlyVisitor(offset, input) {
		let sum = offset;
		for (let step = 0; step < 3; step++) sum += leaf(input);
		return sum;
	};
	const input = {
		value: 0,
		valueOf() {
			return this.value;
		},
	};
	// Coercion can reenter and mutate bias; result typing must not snapshot it.
	globalThis.__boxed_result_leaf = leaf;
	globalThis.__boxed_result_visitor = visitor;
	globalThis.__boxed_result_write = (value) => (bias = value);
	let checksum = 0;
	const operations = 50_000 * scale;
	for (let index = 0; index < operations; index++) {
		bias = (bias + 1) & 255;
		input.value = index & 255;
		checksum = (checksum + visitor(index & 255, input)) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}

globalThis.__boxed_result_run = run;
runRuntimeGapCase("connected-boxed-results", run);
