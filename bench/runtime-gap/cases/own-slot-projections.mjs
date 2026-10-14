import { runRuntimeGapCase } from "../case-runner.mjs";
function pair(record) {
	return record.a + record.b;
}
function triple(record) {
	return record.a + record.b + record.c;
}
function quad(record) {
	return record.a + record.b + record.c + record.d;
}
function run(scale) {
	const make = [
		() => ({}),
		() => [],
		() => new Float64Array(2),
		() => new Map(),
		() => new Set(),
		() => new Date(0),
		() => /x/g,
		() => Promise.resolve(1),
		() => new ArrayBuffer(8),
		() => new DataView(new ArrayBuffer(8)),
		() => function callable() {},
		() => (() => {}).bind(null),
	];
	const records = Array.from({ length: 96 }, (_, index) =>
		Object.assign(make[index % make.length](), { a: index, b: 2, c: 3, d: 4 }),
	);
	let checksum = 0;
	const rounds = 2000 * scale;
	for (let round = 0; round < rounds; round++)
		for (const record of records)
			checksum = (checksum + pair(record) + triple(record) + quad(record)) | 0;
	return { checksum: checksum >>> 0, operations: rounds * records.length * 3 };
}
runRuntimeGapCase("own-slot-projections", run);
