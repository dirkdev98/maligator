import { runRuntimeGapCase } from "../case-runner.mjs";

const seed = Number(process.argv[2] ?? "1") & 255;
const expectedArrays = Array.from({ length: 32 }, (_, arrayIndex) =>
	Array.from({ length: 16 }, (_, index) => (seed + arrayIndex + index) & 255),
);
const valueArrays = expectedArrays.map((expected) => {
	const values = expected.slice();

	return values;
});
let currentExpected = expectedArrays[0];

function reusedPredicate(value, position) {
	return value === currentExpected[position];
}

function indexedEvery(values, expected) {
	for (let position = 0; position < values.length; position++) {
		if (values[position] !== expected[position]) return false;
	}
	return true;
}

function run(scale) {
	let checksum = 0;
	const operations = 100_000 * scale;
	for (let index = 0; index < operations; index++) {
		const selected = index & 31;
		const values = valueArrays[selected];
		const expected = expectedArrays[selected];
		checksum += values.every((value, position) => value === expected[position]) ? 1 : 0;
	}
	return { checksum: checksum >>> 0, operations };
}

runRuntimeGapCase("short-every-captured-16-equal", run);
