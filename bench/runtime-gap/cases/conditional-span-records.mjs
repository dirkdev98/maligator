import { runRuntimeGapCase } from "../case-runner.mjs";

function computeSpan(start, width) {
	return { start, end: start + width, valid: width > 0 };
}
function spanWidth(start, width, trace, observer) {
	const span = computeSpan(start, width);
	if (trace) observer(span);
	return span.valid ? span.end - span.start : 0;
}
function run(scale) {
	let observed = 0;
	const observer = (span) => {
		observed += span.start;
		span.end += 1;
	};
	let checksum = 0;
	const rounds = 600 * scale;
	for (let round = 0; round < rounds; round++)
		for (let index = 0; index < 256; index++)
			checksum += spanWidth(
				index * 3,
				(index % 17) + 1,
				(index & 255) === (round & 255),
				observer,
			);
	return { checksum: (checksum + observed) % 1000000007, operations: rounds * 256 };
}
runRuntimeGapCase("conditional-span-records", run);
