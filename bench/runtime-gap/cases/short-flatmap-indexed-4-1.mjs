import { runRuntimeGapCase } from "../case-runner.mjs";

const seed = Number(process.argv[2] ?? "1") & 255;
const preparedRows = Array.from({ length: 4 }, (_, row) => ({
	values: Array.from({ length: 1 }, (_, column) => (seed + row + column) & 255),
}));
const retained = new Array(256);

function run(scale) {
	let checksum = 0;
	const operations = 10_000 * scale;
	for (let index = 0; index < operations; index++) {
		const result = (() => {
			const result = [];
			for (let row = 0; row < preparedRows.length; row++) {
				const values = preparedRows[row].values;
				for (let position = 0; position < values.length; position++) {
					result.push(values[position]);
				}
			}
			return result;
		})();
		retained[index & 255] = result;
		checksum = (checksum + result.length) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}

function verify() {
	for (const result of retained) {
		if (!Array.isArray(result) || result.length !== 4) {
			throw new Error("flatMap result differs");
		}
	}
}

runRuntimeGapCase("short-flatmap-indexed-4-1", run, verify);
