import { runRuntimeGapCase } from "../case-runner.mjs";

function endpoints(a0, a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11, a12, a13, a14, a15) {
	return a0 + a15;
}

// Resolve once outside timing without exposing an exact callee identity to Core.
const target = Reflect.get({ target: endpoints }, process.argv[4] ?? "target");
if (typeof target !== "function") throw new Error("unknown call target");

function run(scale) {
	const operations = 100_000 * scale;
	let checksum = 0;
	for (let index = 0; index < operations; index++) {
		checksum =
			(checksum + target(index & 31, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 7)) |
			0;
	}
	return { checksum: checksum >>> 0, operations };
}

function verify({ checksum, operations }) {
	if (checksum !== ((operations / 32) * 720) >>> 0) {
		throw new Error("fixed-arity call checksum mismatch");
	}
}

runRuntimeGapCase("call-fixed-sixteen-args", run, verify);
