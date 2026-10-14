import { runRuntimeGapCase } from "../case-runner.mjs";
function step(record, scale) {
	record.x = Math.f16round(Math.max(-64, Math.min(record.x + record.vx, 64)));
	record.y = Math.round(Math.max(-64, Math.min(record.y + record.vy, 64)));
	record.vx = Math.imul(record.vx, scale);
	record.vy = Math.abs(record.vy);
	return record.x + record.y;
}
function run(scale) {
	const records = Array.from({ length: 64 }, (_, index) => ({
		x: index - 32,
		y: index & 15,
		vx: (index & 7) - 3,
		vy: (index & 3) - 1,
	}));
	const rounds = 5000 * scale;
	let checksum = 0;
	for (let iteration = 0; iteration < rounds; iteration++)
		for (const record of records) checksum = (checksum + step(record, -1)) | 0;
	return { checksum: checksum >>> 0, operations: rounds * records.length };
}
runRuntimeGapCase("number-record-math", run);
