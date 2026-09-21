import { runRuntimeGapCase } from "../case-runner.mjs";

const seed = Number(process.argv[2] ?? "1") & 255;

class Left {
	constructor(value) {
		this.value = value;
		this.kind = 1;
	}
}

class Right {
	constructor(value) {
		this.value = value;
		this.kind = 2;
	}
}

const constructors = [Left, Right];
const retained = new Array(256);

function run(scale) {
	let checksum = 0;
	const operations = 50_000 * scale;
	for (let index = 0; index < operations; index++) {
		const value = (seed + index) & 255;
		const Constructor = constructors[index & 1];
		const record = new Constructor(value);
		retained[index & 255] = record;
		checksum = (checksum + record.kind) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}

function verify() {
	for (let index = 0; index < retained.length; index++) {
		const record = retained[index];
		if (!(record instanceof constructors[index & 1]) || record.kind !== (index & 1) + 1) {
			throw new Error("selected constructor result differs");
		}
	}
}

runRuntimeGapCase("constructor-base-selected-retained", run, verify);
