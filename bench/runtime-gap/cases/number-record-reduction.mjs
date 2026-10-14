import { runRuntimeGapCase } from "../case-runner.mjs";
function sum(record) {
	return (
		record.f0 +
		record.f1 +
		record.f2 +
		record.f3 +
		record.f4 +
		record.f5 +
		record.f6 +
		record.f7 +
		record.f8 +
		record.f9 +
		record.f10 +
		record.f11 +
		record.f12 +
		record.f13 +
		record.f14 +
		record.f15 +
		record.f16 +
		record.f17 +
		record.f18 +
		record.f19 +
		record.f20 +
		record.f21 +
		record.f22 +
		record.f23
	);
}
function run(scale) {
	const records = Array.from({ length: 32 }, (_, index) =>
		Object.freeze({
			f0: index + 0,
			f1: index + 1,
			f2: index + 2,
			f3: index + 3,
			f4: index + 4,
			f5: index + 5,
			f6: index + 6,
			f7: index + 7,
			f8: index + 8,
			f9: index + 9,
			f10: index + 10,
			f11: index + 11,
			f12: index + 12,
			f13: index + 13,
			f14: index + 14,
			f15: index + 15,
			f16: index + 16,
			f17: index + 17,
			f18: index + 18,
			f19: index + 19,
			f20: index + 20,
			f21: index + 21,
			f22: index + 22,
			f23: index + 23,
		}),
	);
	let checksum = 0;
	const rounds = 10000 * scale;
	for (let i = 0; i < rounds; i++)
		for (const record of records) checksum = (checksum + sum(record)) | 0;
	return { checksum: checksum >>> 0, operations: rounds * records.length };
}
runRuntimeGapCase("number-record-reduction", run);
