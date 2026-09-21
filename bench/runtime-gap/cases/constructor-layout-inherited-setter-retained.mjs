import { runRuntimeGapCase } from "../case-runner.mjs";

const seed = Number(process.argv[2] ?? "1") & 255;

class Base {
	set value(value) {
		this.seen = (value + 1) & 255;
	}
}

class Record extends Base {
	constructor(value) {
		super();
		this.value = value;
	}
}

const retained = new Array(256);

function run(scale) {
	let checksum = 0;
	const operations = 50_000 * scale;
	for (let index = 0; index < operations; index++) {
		const record = new Record((seed + index) & 255);
		retained[index & 255] = record;
		checksum = (checksum + record.seen) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}

function verify() {
	for (const record of retained) {
		if (
			!(record instanceof Record) ||
			Object.hasOwn(record, "value") ||
			record.seen === undefined
		) {
			throw new Error("inherited setter semantics differ");
		}
	}
}

runRuntimeGapCase("constructor-layout-inherited-setter-retained", run, verify);
