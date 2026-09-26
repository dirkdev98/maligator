import { runRuntimeGapCase } from "../case-runner.mjs";

const ROW_COUNT = 8192;
const ROUNDS = 100;
const MODULUS = 1_000_000_007;
const KEYS = ["a", "b", "c", "d", "e", "f"];

function readRecord(row) {
	const a = row.a;
	const b = row.b;
	const c = row.c;
	const d = row.d;
	const e = row.e;
	const f = row.f;
	return (
		(a === d ? 1 : 0) |
		(b === e ? 2 : 0) |
		(c === f ? 4 : 0) |
		(a === b ? 8 : 0) |
		(d === e ? 16 : 0)
	);
}

function run(scale) {
	const tokens = Array.from({ length: 8 }, () => ({}));
	const rows = [];
	let expectedRound = 0;
	for (let index = 0; index < ROW_COUNT; index++) {
		const row = Object.create(null);
		const indices = [];
		for (let field = 0; field < KEYS.length; field++) {
			const token = (index >>> field) & 7;
			indices.push(token);
			row[KEYS[field]] = tokens[token];
		}
		rows.push(row);
		expectedRound +=
			(indices[0] === indices[3] ? 1 : 0) |
			(indices[1] === indices[4] ? 2 : 0) |
			(indices[2] === indices[5] ? 4 : 0) |
			(indices[0] === indices[1] ? 8 : 0) |
			(indices[3] === indices[4] ? 16 : 0);
	}
	const rounds = ROUNDS * scale;
	let checksum = 0;
	let operations = 0;
	for (let round = 0; round < rounds; round++) {
		for (let index = 0; index < rows.length; index++) {
			checksum += readRecord(rows[index]);
			operations += 6;
		}
	}
	return {
		checksum: checksum % MODULUS,
		operations,
		expectedChecksum: (expectedRound * rounds) % MODULUS,
		expectedOperations: ROW_COUNT * rounds * 6,
	};
}

runRuntimeGapCase("native-property-owned-6", run, (result) => {
	if (
		result.checksum !== result.expectedChecksum ||
		result.operations !== result.expectedOperations
	) {
		throw new Error(`Unexpected owned-6 result: ${JSON.stringify(result)}`);
	}
});
