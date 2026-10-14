import { runRuntimeGapCase } from "../case-runner.mjs";
function matches(record, needle) {
	const f0 = record.f0;
	const f1 = record.f1;
	const f2 = record.f2;
	const f3 = record.f3;
	const f4 = record.f4;
	const f5 = record.f5;
	const f6 = record.f6;
	const f7 = record.f7;
	const f8 = record.f8;
	const f9 = record.f9;
	const f10 = record.f10;
	const f11 = record.f11;
	const f12 = record.f12;
	const f13 = record.f13;
	const f14 = record.f14;
	const f15 = record.f15;
	const f16 = record.f16;
	const f17 = record.f17;
	const f18 = record.f18;
	const f19 = record.f19;
	const f20 = record.f20;
	const f21 = record.f21;
	const f22 = record.f22;
	const f23 = record.f23;
	return (
		(f0 === needle ? 1 : 0) +
		(f1 === needle ? 1 : 0) +
		(f2 === needle ? 1 : 0) +
		(f3 === needle ? 1 : 0) +
		(f4 === needle ? 1 : 0) +
		(f5 === needle ? 1 : 0) +
		(f6 === needle ? 1 : 0) +
		(f7 === needle ? 1 : 0) +
		(f8 === needle ? 1 : 0) +
		(f9 === needle ? 1 : 0) +
		(f10 === needle ? 1 : 0) +
		(f11 === needle ? 1 : 0) +
		(f12 === needle ? 1 : 0) +
		(f13 === needle ? 1 : 0) +
		(f14 === needle ? 1 : 0) +
		(f15 === needle ? 1 : 0) +
		(f16 === needle ? 1 : 0) +
		(f17 === needle ? 1 : 0) +
		(f18 === needle ? 1 : 0) +
		(f19 === needle ? 1 : 0) +
		(f20 === needle ? 1 : 0) +
		(f21 === needle ? 1 : 0) +
		(f22 === needle ? 1 : 0) +
		(f23 === needle ? 1 : 0)
	);
}
function run(scale) {
	const records = Array.from({ length: 32 }, (_, index) => {
		const record = function record() {};
		if (index % 2) record.prefix = "alternate layout";
		return Object.assign(record, {
			f0: (index + 0) % 3 === 0 ? "yes" : "no",
			f1: (index + 1) % 3 === 0 ? "yes" : "no",
			f2: (index + 2) % 3 === 0 ? "yes" : "no",
			f3: (index + 3) % 3 === 0 ? "yes" : "no",
			f4: (index + 4) % 3 === 0 ? "yes" : "no",
			f5: (index + 5) % 3 === 0 ? "yes" : "no",
			f6: (index + 6) % 3 === 0 ? "yes" : "no",
			f7: (index + 7) % 3 === 0 ? "yes" : "no",
			f8: (index + 8) % 3 === 0 ? "yes" : "no",
			f9: (index + 9) % 3 === 0 ? "yes" : "no",
			f10: (index + 10) % 3 === 0 ? "yes" : "no",
			f11: (index + 11) % 3 === 0 ? "yes" : "no",
			f12: (index + 12) % 3 === 0 ? "yes" : "no",
			f13: (index + 13) % 3 === 0 ? "yes" : "no",
			f14: (index + 14) % 3 === 0 ? "yes" : "no",
			f15: (index + 15) % 3 === 0 ? "yes" : "no",
			f16: (index + 16) % 3 === 0 ? "yes" : "no",
			f17: (index + 17) % 3 === 0 ? "yes" : "no",
			f18: (index + 18) % 3 === 0 ? "yes" : "no",
			f19: (index + 19) % 3 === 0 ? "yes" : "no",
			f20: (index + 20) % 3 === 0 ? "yes" : "no",
			f21: (index + 21) % 3 === 0 ? "yes" : "no",
			f22: (index + 22) % 3 === 0 ? "yes" : "no",
			f23: (index + 23) % 3 === 0 ? "yes" : "no",
		});
	});
	let checksum = 0;
	const rounds = 10000 * scale;
	for (let i = 0; i < rounds; i++)
		for (const record of records) checksum = (checksum + matches(record, "yes")) | 0;
	return { checksum: checksum >>> 0, operations: rounds * records.length };
}
runRuntimeGapCase("property-read-wide", run);
