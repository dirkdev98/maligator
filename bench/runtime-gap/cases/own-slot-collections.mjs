import { runRuntimeGapCase } from "../case-runner.mjs";
function read(record) {
	const left = record.left;
	const right = record.right;
	const tail = record.tail;
	return left === right ? tail : 0;
}
function total(record) {
	return record.a + record.b + record.c + record.d + record.e;
}
function run(scale) {
	const marker = { value: 7 };
	const records = Array.from({ length: 96 }, (_, index) =>
		Object.assign(
			index % 4 === 0
				? []
				: index % 4 === 1
					? new Float64Array(4)
					: index % 4 === 2
						? new Map()
						: new Set(),
			{ left: marker, right: marker, tail: index, a: index, b: 2, c: 3, d: 4, e: 5 },
		),
	);
	let checksum = 0;
	const rounds = 2000 * scale;
	for (let i = 0; i < rounds; i++)
		for (const record of records)
			checksum = (checksum + read(record) + total(record)) | 0;
	return { checksum: checksum >>> 0, operations: rounds * records.length };
}
runRuntimeGapCase("own-slot-collections", run);
