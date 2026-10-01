import { runRuntimeGapCase } from "../case-runner.mjs";

function addWithReceiver(left, right) {
	return this.bias + left + right;
}

// A runtime property name keeps the hot target opaque to Core and native inlining.
const method = process.argv[4] ?? "target";
const receiver = { bias: 3, target: addWithReceiver };
if (typeof receiver[method] !== "function") throw new Error("unknown call target");

function run(scale) {
	const operations = 100_000 * scale;
	let checksum = 0;
	for (let index = 0; index < operations; index++) {
		checksum = (checksum + receiver[method](index & 31, 7)) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}

function verify({ checksum, operations }) {
	if (checksum !== ((operations / 32) * 816) >>> 0) {
		throw new Error("receiver call checksum mismatch");
	}
}

runRuntimeGapCase("call-this-two-args", run, verify);
