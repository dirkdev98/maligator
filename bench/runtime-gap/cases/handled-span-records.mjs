import { runRuntimeGapCase } from "../case-runner.mjs";

function handledSpanWidth(start, width, prepare, trace, observer) {
	function make(value, size) {
		return { start: value, end: value + size, valid: size > 0 };
	}
	let adjustment;
	try {
		adjustment = prepare(start);
	} catch (error) {
		adjustment = error;
	}
	const span = make(start, width);
	if (trace) observer(span);
	span.end += adjustment;
	return span.valid ? span.end - span.start : 0;
}

function run(scale) {
	let prepared = 0;
	let observed = 0;
	const prepare = (start) => {
		prepared++;
		if ((start & 255) === 17) throw 2;
		return 1;
	};
	const observer = (span) => {
		observed += span.start;
		span.end += 3;
	};
	const rounds = 300 * scale;
	let checksum = 0;
	for (let round = 0; round < rounds; round++)
		for (let index = 0; index < 256; index++)
			checksum += handledSpanWidth(
				index,
				(index % 17) + 1,
				prepare,
				(index & 63) === (round & 63),
				observer,
			);
	return { checksum: checksum + prepared + observed, operations: rounds * 256 };
}

runRuntimeGapCase("handled-span-records", run);
