import { runRuntimeGapCase } from "../case-runner.mjs";

const seed = Number(process.argv[2] ?? "1") & 255;
const pairs = Array.from({ length: 8 }, (_, index) => [
	"p" + (index & 1),
	(seed + index) & 255,
]);
const retained = new Array(256);

function run(scale) {
	let checksum = 0;
	const operations = 20_000 * scale;
	for (let index = 0; index < operations; index++) {
		const result = (() => {
			const result = {};
			for (let position = 0; position < pairs.length; position++) {
				result[pairs[position][0]] = pairs[position][1];
			}
			return result;
		})();
		retained[index & 255] = result;
		checksum = (checksum + 2) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}

function verify() {
	for (const result of retained) {
		if (result === undefined || Object.keys(result).length !== 2) {
			throw new Error("fromEntries result differs");
		}
	}
}

runRuntimeGapCase("object-from-entries-small-indexed-repeated-8", run, verify);
