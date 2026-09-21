import { runRuntimeGapCase } from "../case-runner.mjs";

const seed = Number(process.argv[2] ?? "1") & 255;

class Base {
	constructor(left) {
		this.left = left;
	}
}

class Pair extends Base {
	constructor(left, right) {
		super(left);
		this.right = right;
	}
}

const retained = new Array(256);

function run(scale) {
	let checksum = 0;
	const operations = 50_000 * scale;
	for (let index = 0; index < operations; index++) {
		const left = (seed + index) & 255;
		const pair = new Pair(left, (left + 1) & 255);
		retained[index & 255] = pair;
		checksum = (checksum + pair.left + pair.right) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}

function verify() {
	for (const pair of retained) {
		if (!(pair instanceof Pair) || !(pair instanceof Base)) {
			throw new Error("derived receiver differs");
		}
	}
}

runRuntimeGapCase("constructor-derived-super-retained", run, verify);
