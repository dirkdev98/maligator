import { runRuntimeGapCase } from "../case-runner.mjs";

const ROW_COUNT = 8192;
const ROUNDS = 100;
const GETTER_INTERVAL = 1024;
const MODULUS = 1_000_000_007;
const OWN_KEYS = ["a", "b", "d"];

function readRecord(row, returnedToken) {
	const a = row.a;
	const b = row.b;
	const c = row.c;
	const d = row.d;
	const e = row.e;
	const f = row.f;
	return (
		(a === c ? 1 : 0) |
		(b === e ? 2 : 0) |
		(d === f ? 4 : 0) |
		(c === returnedToken ? 8 : 0)
	);
}

function run(scale) {
	const tokens = Array.from({ length: 5 }, () => ({}));
	const normalPrototype = { c: tokens[0], e: tokens[1], f: tokens[2] };
	const afterPrototype = { c: tokens[3], e: tokens[0], f: tokens[4] };
	const getterPrototype = Object.create(null);
	let getterCalls = 0;
	Object.defineProperty(getterPrototype, "c", {
		get() {
			getterCalls++;
			this.d = tokens[4];
			Object.setPrototypeOf(this, afterPrototype);
			return tokens[3];
		},
	});
	const rows = [];
	for (let index = 0; index < ROW_COUNT; index++) {
		const row = Object.create(normalPrototype);
		for (let field = 0; field < OWN_KEYS.length; field++) {
			row[OWN_KEYS[field]] = tokens[field];
		}
		rows.push(row);
	}
	const rounds = ROUNDS * scale;
	let checksum = 0;
	let operations = 0;
	for (let round = 0; round < rounds; round++) {
		for (let index = 0; index < rows.length; index++) {
			const row = rows[index];
			if ((index & (GETTER_INTERVAL - 1)) === GETTER_INTERVAL - 1) {
				row.d = tokens[2];
				Object.setPrototypeOf(row, getterPrototype);
			}
			checksum += readRecord(row, tokens[3]);
			operations += 6;
		}
	}
	for (let index = GETTER_INTERVAL - 1; index < rows.length; index += GETTER_INTERVAL) {
		if (
			rows[index].d !== tokens[4] ||
			Object.getPrototypeOf(rows[index]) !== afterPrototype
		) {
			throw new Error("Middle getter mutation was not retained");
		}
	}
	const visits = ROW_COUNT * rounds;
	const expectedGetterCalls = (ROW_COUNT / GETTER_INTERVAL) * rounds;
	return {
		checksum: (checksum + getterCalls * 17) % MODULUS,
		operations,
		getterCalls,
		expectedGetterCalls,
		expectedChecksum: (7 * visits + 22 * expectedGetterCalls) % MODULUS,
		expectedOperations: visits * 6,
	};
}

runRuntimeGapCase("native-property-middle-getter", run, (result) => {
	if (
		result.checksum !== result.expectedChecksum ||
		result.operations !== result.expectedOperations ||
		result.getterCalls !== result.expectedGetterCalls
	) {
		throw new Error(`Unexpected middle-getter result: ${JSON.stringify(result)}`);
	}
});
