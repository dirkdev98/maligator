import { runRuntimeGapCase } from "../case-runner.mjs";

const seed = Number(process.argv[2] ?? "1") & 255;

class Pair {
	constructor(value) {
		this.left = (value + 1) & 255;
		this.right = (value * 3) & 255;
	}
}

function run(scale) {
	let checksum = 0;
	const operations = 100_000 * scale;
	for (let index = 0; index < operations; index++) {
		const pair = new Pair((seed + index) & 255);
		checksum = (checksum + pair.left + pair.right) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}

runRuntimeGapCase("constructor-scalar-fields-computed-nonescaping", run);
