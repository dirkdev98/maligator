import { runRuntimeGapCase } from "../case-runner.mjs";

const seed = Number(process.argv[2] ?? "1") & 255;

class Pair {
	constructor(left, right) {
		this.left = left;
		this.right = right;
	}
	sum() {
		return this.left + this.right;
	}
}

const retained = new Array(256);

function run(scale) {
	let checksum = 0;
	const operations = 100_000 * scale;
	for (let index = 0; index < operations; index++) {
		const left = (seed + index) & 255;
		const right = (left + 1) & 255;

		checksum = (checksum + new Pair(left, right).sum()) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}

function verify() {}

runRuntimeGapCase("constructor-scalar-fields-immediate-method", run, verify);
