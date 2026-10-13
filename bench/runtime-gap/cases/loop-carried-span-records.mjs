import { runRuntimeGapCase } from "../case-runner.mjs";

function spanWidths(fallback, start, width, trace, observer) {
	function make(value, size) {
		return { start: value, end: value + size, valid: size > 0 };
	}
	const original = make(start, width);
	let span = fallback;
	let sum = 0;
	for (let index = 0; index < 16; index++) {
		if (index % 3 === 0) span = original;
		if (index % 3 === 1) span = fallback;
		if (trace && index === 9) observer(span);
		sum += span.valid ? span.end - span.start : 0;
	}
	return sum;
}

function run(scale) {
	const fallback = { start: 1, end: 4, valid: true };
	let observed = 0;
	const observer = (span) => {
		observed += span.start;
		span.end += 1;
	};
	let checksum = 0;
	const rounds = 300 * scale;
	for (let round = 0; round < rounds; round++)
		for (let index = 0; index < 256; index++)
			checksum += spanWidths(
				fallback,
				index * 3,
				(index % 17) + 1,
				(index & 255) === (round & 255),
				observer,
			);
	return { checksum: (checksum + observed) % 1000000007, operations: rounds * 256 * 16 };
}

runRuntimeGapCase("loop-carried-span-records", run);
