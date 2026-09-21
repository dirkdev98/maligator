import { runRuntimeGapCase } from "../case-runner.mjs";

const seed = Number(process.argv[2] ?? "1") & 255;

class Base {
	constructor(value) {
		this.value = value;
		this.kind = new.target === Base ? 1 : 2;
	}
}

class Derived extends Base {}

const constructors = [Base, Derived];
const retained = new Array(256);

function run(scale) {
	let checksum = 0;
	const operations = 50_000 * scale;
	for (let index = 0; index < operations; index++) {
		const Constructor = constructors[index & 1];
		const record = new Constructor((seed + index) & 255);
		retained[index & 255] = record;
		checksum = (checksum + record.kind) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}

function verify() {
	for (let index = 0; index < retained.length; index++) {
		const record = retained[index];
		if (!(record instanceof constructors[index & 1]) || record.kind !== (index & 1) + 1) {
			throw new Error("new.target observation differs");
		}
	}
}

runRuntimeGapCase("constructor-new-target-selected-retained", run, verify);
