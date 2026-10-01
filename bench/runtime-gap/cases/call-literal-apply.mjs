import { runRuntimeGapCase } from "../case-runner.mjs";

function sum(first, last) {
	return this.bias + first + last;
}

const target = Reflect.get({ target: sum }, process.argv[4] ?? "target");
const receiver = { bias: 3 };
if (typeof target !== "function") throw new Error("unknown call target");

function run(scale) {
	const operations = 100_000 * scale;
	let checksum = 0;
	for (let index = 0; index < operations; index++) {
		checksum = (checksum + Reflect.apply(target, receiver, [index & 31, 7])) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}

function verify({ checksum, operations }) {
	if (checksum !== ((operations / 32) * 816) >>> 0) {
		throw new Error("literal apply checksum mismatch");
	}
}

runRuntimeGapCase("call-literal-apply", run, verify);
