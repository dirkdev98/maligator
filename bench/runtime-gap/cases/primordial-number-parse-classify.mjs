import { runRuntimeGapCase } from "../case-runner.mjs";

const records = [
	["42.5px", 10, 42.5, 42, 1, 11],
	["-17tail", 10, -17, -17, 11, 11],
	["2a", 16, 2, 42, 11, 11],
	["0x2a", 16, 0, 42, 11, 11],
	["NaN", 10, NaN, NaN, 4, 4],
	["Infinity", 10, Infinity, NaN, 0, 4],
	["9007199254740992", 10, 9007199254740992, 9007199254740992, 3, 3],
	[" -0.25 rest", 10, -0.25, -0, 1, 11],
];

function classify(value) {
	return (
		(Number.isFinite(value) ? 1 : 0) +
		(Number.isInteger(value) ? 2 : 0) +
		(Number.isNaN(value) ? 4 : 0) +
		(Number.isSafeInteger(value) ? 8 : 0)
	);
}

function run(scale) {
	const operations = 3000 * scale;
	let checksum = 0;
	for (let round = 0; round < operations; round++) {
		const record = records[round & 7];
		const floating = Number.parseFloat(record[0]);
		const integer = Number.parseInt(record[0], record[1]);
		const floatFlags = classify(floating);
		const integerFlags = classify(integer);
		if (
			floatFlags !== record[4] ||
			integerFlags !== record[5] ||
			(record[4] !== 4 && floating !== record[2]) ||
			(record[5] !== 4 && integer !== record[3]) ||
			((round & 7) === 7 && 1 / integer !== -Infinity)
		)
			throw new Error("number parsing mismatch");
		checksum += floatFlags * 17 + integerFlags * 31;
		if (floatFlags & 1) checksum += Math.round((floating % 1000003) * 100);
		if (integerFlags & 1) checksum += integer % 1000003;
	}
	return { checksum: ((checksum % 1000000007) + 1000000007) % 1000000007, operations };
}

runRuntimeGapCase("primordial-number-parse-classify", run);
