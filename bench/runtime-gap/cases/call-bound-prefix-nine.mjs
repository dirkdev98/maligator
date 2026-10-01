import { runRuntimeGapCase } from "../case-runner.mjs";

function boundEndpoints(a0, a1, a2, a3, a4, a5, a6, a7, a8) {
	return this.bias + a0 + a8;
}

const bound = boundEndpoints.bind({ bias: 3 }, 7, 1, 2, 3);
const target = Reflect.get({ target: bound }, process.argv[4] ?? "target");
if (typeof target !== "function") throw new Error("unknown call target");

function run(scale) {
	const operations = 100_000 * scale;
	let checksum = 0;
	for (let index = 0; index < operations; index++) {
		checksum = (checksum + target(4, 5, 6, 7, index & 31)) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}

function verify({ checksum, operations }) {
	if (checksum !== ((operations / 32) * 816) >>> 0) {
		throw new Error("bound receiver or prefix checksum mismatch");
	}
}

runRuntimeGapCase("call-bound-prefix-nine", run, verify);
