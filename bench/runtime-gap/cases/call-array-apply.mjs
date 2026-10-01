import { runRuntimeGapCase } from "../case-runner.mjs";

function sum(first, last) {
	return this.bias + first + last;
}

const target = Reflect.get({ target: sum }, process.argv[4] ?? "target");
const values = Reflect.get({ values: [1, 7] }, process.argv[5] ?? "values");
const receiver = { bias: 3 };
if (typeof target !== "function" || !Array.isArray(values)) {
	throw new Error("unknown array call input");
}

function run(scale) {
	const operations = 100_000 * scale;
	let checksum = 0;
	for (let index = 0; index < operations; index++) {
		checksum = (checksum + Reflect.apply(target, receiver, values)) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}

function verify({ checksum, operations }) {
	if (checksum !== (operations * 11) >>> 0) {
		throw new Error("array apply checksum mismatch");
	}
}

runRuntimeGapCase("call-array-apply", run, verify);
