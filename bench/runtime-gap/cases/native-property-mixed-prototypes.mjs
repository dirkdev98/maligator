import { runRuntimeGapCase } from "../case-runner.mjs";

const ROW_COUNT = 4096;
const ROUNDS = 100;
const MODULUS = 1_000_000_007;
const OWN_KEYS = ["a", "c", "e"];
const INHERITED_KEYS = ["b", "d", "f"];

function readRecord(row) {
	const a = row.a;
	const b = row.b;
	const c = row.c;
	const d = row.d;
	const e = row.e;
	const f = row.f;
	return (
		(a === b ? 1 : 0) |
		(c === d ? 2 : 0) |
		(e === f ? 4 : 0) |
		(b === f ? 8 : 0) |
		(a === e ? 16 : 0)
	);
}

function run(scale) {
	const tokens = Array.from({ length: 8 }, () => ({}));
	const inheritedIndices = [
		[0, 3, 5],
		[6, 3, 0],
	];
	const groups = [];
	let expectedRound = 0;
	for (let group = 0; group < inheritedIndices.length; group++) {
		const inherited = inheritedIndices[group];
		const prototype = Object.create(null);
		for (let field = 0; field < INHERITED_KEYS.length; field++) {
			prototype[INHERITED_KEYS[field]] = tokens[inherited[field]];
		}
		const rows = [];
		for (let index = 0; index < ROW_COUNT; index++) {
			const row = Object.create(prototype);
			const own = [];
			for (let field = 0; field < OWN_KEYS.length; field++) {
				const token = (index >>> field) & 7;
				own.push(token);
				row[OWN_KEYS[field]] = tokens[token];
			}
			rows.push(row);
			expectedRound +=
				(own[0] === inherited[0] ? 1 : 0) |
				(own[1] === inherited[1] ? 2 : 0) |
				(own[2] === inherited[2] ? 4 : 0) |
				(inherited[0] === inherited[2] ? 8 : 0) |
				(own[0] === own[2] ? 16 : 0);
		}
		groups.push(rows);
	}
	const rounds = ROUNDS * scale;
	let checksum = 0;
	let operations = 0;
	for (let round = 0; round < rounds; round++) {
		for (let group = 0; group < groups.length; group++) {
			const rows = groups[group];
			for (let index = 0; index < rows.length; index++) {
				checksum += readRecord(rows[index]);
				operations += 6;
			}
		}
	}
	return {
		checksum: checksum % MODULUS,
		operations,
		expectedChecksum: (expectedRound * rounds) % MODULUS,
		expectedOperations: ROW_COUNT * inheritedIndices.length * rounds * 6,
	};
}

runRuntimeGapCase("native-property-mixed-prototypes", run, (result) => {
	if (
		result.checksum !== result.expectedChecksum ||
		result.operations !== result.expectedOperations
	) {
		throw new Error(`Unexpected mixed-prototype result: ${JSON.stringify(result)}`);
	}
});
