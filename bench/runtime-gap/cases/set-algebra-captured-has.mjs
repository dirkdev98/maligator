import { runRuntimeGapCase } from "../case-runner.mjs";
function run(scale) {
	const factor = 3;
	const source = new Set();
	for (let index = 0; index < 256; index++) source.add(index);
	const other = {
		size: 256,
		has(value) {
			return (value * factor) % 7 === 0;
		},
		keys() {
			throw new Error("unused keys");
		},
	};
	const rounds = 500 * scale;
	let checksum = 0;
	for (let round = 0; round < rounds; round++) {
		const result = source.intersection(other);
		checksum += result.size + Number(result.has(round & 255));
	}
	return { checksum, operations: rounds * source.size };
}
runRuntimeGapCase("set-algebra-captured-has", run);
