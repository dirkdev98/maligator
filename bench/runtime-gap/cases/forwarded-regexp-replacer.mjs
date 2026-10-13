import { runRuntimeGapCase } from "../case-runner.mjs";
function replace(subject, pattern, callbacks, index) {
	return subject.replaceAll(pattern, callbacks[index]);
}
function run(scale) {
	const subject = Array.from({ length: 128 }, (_, index) => "tag" + index).join(",");
	const pattern = /tag(\d+)/g;
	const factor = 3;
	const callbacks = [
		function first(match, digits, offset) {
			return String(+digits * factor + (offset & 1));
		},
		function second(match, digits, offset) {
			return String(+digits * (factor + 1) + (offset & 1));
		},
	];
	const rounds = 500 * scale;
	let checksum = 0;
	for (let round = 0; round < rounds; round++) {
		const output = replace(subject, pattern, callbacks, round & 1);
		checksum += output.length + output.charCodeAt(output.length - 1);
	}
	return { checksum, operations: rounds * 128 };
}
runRuntimeGapCase("forwarded-regexp-replacer", run);
