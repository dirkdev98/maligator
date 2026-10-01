import { runRuntimeGapCase } from "../case-runner.mjs";

function boundReceiver(value) {
	return this.bias + value;
}

let chain = boundReceiver.bind({ bias: 10 });
for (let depth = 1; depth < 32; depth++) chain = chain.bind({ bias: depth + 100 });
// Runtime-key lookup keeps both the bound chain and target call visible at runtime.
const target = Reflect.get({ target: chain }, process.argv[4] ?? "target");
if (typeof target !== "function") throw new Error("unknown call target");

function run(scale) {
	const operations = 100_000 * scale;
	let checksum = 0;
	for (let index = 0; index < operations; index++) {
		checksum = (checksum + target(index & 31)) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}

function verify({ checksum, operations }) {
	if (checksum !== ((operations / 32) * 816) >>> 0) {
		throw new Error("bound receiver chain checksum mismatch");
	}
}

runRuntimeGapCase("call-bound-receiver-chain", run, verify);
