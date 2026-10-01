import { runRuntimeGapCase } from "../case-runner.mjs";

const render = Reflect.get(Function.prototype, process.argv[4] ?? "toString");
if (typeof render !== "function") throw new Error("unknown rendering target");

function run(scale) {
	const operations = 100_000 * scale;
	let checksum = 0;
	for (let index = 0; index < operations; index++) {
		const source = render.call(Math.max);
		checksum = (checksum + source.length + source.charCodeAt(9)) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}

function verify({ checksum, operations }) {
	if (checksum !== (operations * 141) >>> 0) {
		throw new Error("function source checksum mismatch");
	}
}

runRuntimeGapCase("call-function-source-reuse", run, verify);
