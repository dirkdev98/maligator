import { runRuntimeGapCase } from "../case-runner.mjs";
function update(record) {
	record.x = (record.x + record.y) * 0.5;
	record.y = (record.y + record.z) * 0.5;
	record.z = (record.z + record.w) * 0.5;
	record.w = (record.w + record.x) * 0.5;
	return record.x + record.y + record.z + record.w;
}
function run(scale) {
	const records = Array.from({ length: 96 }, (_, index) =>
		index % 3 === 0
			? { x: index + 0.5, y: index + 1.5, z: index + 2.5, w: index + 3.5 }
			: index % 3 === 1
				? { padding: 17, w: index + 3.5, z: index + 2.5, y: index + 1.5, x: index + 0.5 }
				: {
						y: index + 1.5,
						label: "mixed",
						x: index + 0.5,
						w: index + 3.5,
						z: index + 2.5,
					},
	);
	for (const record of records)
		for (let extra = 0; extra < 40; extra++) record[`extra${extra}`] = extra;
	let checksum = 0;
	const rounds = 10000 * scale;
	for (let i = 0; i < rounds; i++)
		for (const record of records) checksum = (checksum + update(record)) | 0;
	return { checksum: checksum >>> 0, operations: rounds * records.length };
}
runRuntimeGapCase("number-record-grown", run);
