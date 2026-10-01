import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const operations = 900 * scale;
	let checksum = 0;
	for (let round = 0; round < operations; round++) {
		const before = { inherited: round + 1 };
		const after = { inherited: round + 5, extra: round & 15 };
		const record = Object.create(before);
		record.own = round * 3;
		const first = record.inherited;
		const changed = Object.setPrototypeOf(record, after);
		const prototype = Object.getPrototypeOf(record);
		const key = round & 1 ? "own" : "inherited";
		const staticOwn = Object.hasOwn(record, key);
		const prototypeOwn = Object.prototype.hasOwnProperty.call(record, key);
		if (
			changed !== record ||
			prototype !== after ||
			record.inherited !== round + 5 ||
			staticOwn !== prototypeOwn
		)
			throw new Error("prototype ownership failed");
		checksum +=
			first + record.inherited + prototype.extra + record.own + (staticOwn ? 17 : 29);
	}
	return { checksum: checksum % 1000000007, operations };
}

runRuntimeGapCase("primordial-object-prototype-ownership", run);
