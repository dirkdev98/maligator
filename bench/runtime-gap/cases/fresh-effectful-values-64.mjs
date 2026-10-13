import { runRuntimeGapCase } from "../case-runner.mjs";
const retained = new Array(32);
function make(factory, source) {
	return [
		factory(0),
		source.value,
		factory(2),
		source.value,
		factory(4),
		source.value,
		factory(6),
		source.value,
		factory(8),
		source.value,
		factory(10),
		source.value,
		factory(12),
		source.value,
		factory(14),
		source.value,
		factory(16),
		source.value,
		factory(18),
		source.value,
		factory(20),
		source.value,
		factory(22),
		source.value,
		factory(24),
		source.value,
		factory(26),
		source.value,
		factory(28),
		source.value,
		factory(30),
		source.value,
		factory(32),
		source.value,
		factory(34),
		source.value,
		factory(36),
		source.value,
		factory(38),
		source.value,
		factory(40),
		source.value,
		factory(42),
		source.value,
		factory(44),
		source.value,
		factory(46),
		source.value,
		factory(48),
		source.value,
		factory(50),
		source.value,
		factory(52),
		source.value,
		factory(54),
		source.value,
		factory(56),
		source.value,
		factory(58),
		source.value,
		factory(60),
		source.value,
		factory(62),
		source.value,
	];
}
function run(scale) {
	let checksum = 0;
	let seed = 0;
	const source = {
		get value() {
			return seed;
		},
	};
	const factory = (value) => value + seed;
	const rounds = 20000 * scale;
	for (let index = 0; index < rounds; index++) {
		seed = index & 255;
		const result = make(factory, source);
		retained[index & 31] = result;
		checksum = (checksum + result[0] + result[15] + result[31] + result[63]) | 0;
	}
	for (let index = 0; index < 32; index++) checksum += retained[index].length;
	return { checksum: checksum >>> 0, operations: rounds };
}
runRuntimeGapCase("fresh-effectful-values-64", run);
