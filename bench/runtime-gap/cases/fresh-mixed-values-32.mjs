import { runRuntimeGapCase } from "../case-runner.mjs";

const retained = new Array(32);
function make(first, second, reference) {
	first = +first;
	second = +second;
	return [
		reference,
		"tag",
		null,
		undefined,
		true,
		false,
		first + 1,
		second * 2,
		reference,
		"left",
		null,
		undefined,
		true,
		false,
		first - second,
		first < second,
		reference,
		"right",
		null,
		undefined,
		true,
		false,
		first * second,
		-0,
		reference,
		"",
		null,
		undefined,
		true,
		false,
		first + second,
		second - first,
	];
}
function run(scale) {
	let checksum = 0;
	const reference = { marker: 7 };
	const rounds = 20000 * scale;
	for (let i = 0; i < rounds; i++) {
		const result = make(i, i & 255, reference);
		retained[i & 31] = result;
		checksum =
			(checksum +
				result[6] +
				result[7] +
				result[14] +
				result[22] +
				result[30] +
				(result[24] === reference ? 7 : 0)) |
			0;
	}
	for (let i = 0; i < 32; i++) checksum = (checksum + retained[i].length) | 0;
	return { checksum: checksum >>> 0, operations: rounds };
}
runRuntimeGapCase("fresh-mixed-values-32", run);
