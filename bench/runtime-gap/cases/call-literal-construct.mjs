import { runRuntimeGapCase } from "../case-runner.mjs";

function Pair(first, last) {
	this.first = first;
	this.last = last;
}

const target = Reflect.get({ target: Pair }, process.argv[4] ?? "target");
if (typeof target !== "function") throw new Error("unknown construction target");

function run(scale) {
	const operations = 100_000 * scale;
	let checksum = 0;
	for (let index = 0; index < operations; index++) {
		const value = Reflect.construct(target, [index & 31, 7]);
		checksum = (checksum + value.first + value.last) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}

function verify({ checksum, operations }) {
	if (checksum !== ((operations / 32) * 720) >>> 0) {
		throw new Error("literal construct checksum mismatch");
	}
}

runRuntimeGapCase("call-literal-construct", run, verify);
