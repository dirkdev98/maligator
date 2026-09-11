import { parentPort, workerData } from "node:worker_threads";
import { test262LoadInputs } from "./cache.ts";
import { TEST262_METADATA } from "./constants.ts";
import {
	test262DrainStats,
	test262RunBatch,
	test262SetNativeBuildInputs,
} from "./runtime.ts";
import type { Test262NativeBuildInputs } from "./runtime.ts";
import type { Test262Input } from "./types.ts";

if (!parentPort) {
	throw new Error("compile-worker must run as a worker thread");
}
const port = parentPort;
const inputs = workerData as {
	nativeBuildInputs: Test262NativeBuildInputs;
	corpusRoot: string;
};
test262SetNativeBuildInputs(inputs.nativeBuildInputs);
TEST262_METADATA.path = inputs.corpusRoot;

type IncomingMessage =
	| { type: "batch"; inputs: Array<Test262Input>; workerId: number }
	| { type: "drain" };

port.on("message", (message: IncomingMessage) => {
	if (message.type === "drain") {
		port.postMessage({ type: "stats", snapshot: test262DrainStats() });
		port.close();
		return;
	}

	void runBatch(message.inputs, message.workerId);
});

async function runBatch(inputs: Array<Test262Input>, workerId: number) {
	const files = test262LoadInputs(TEST262_METADATA.path, inputs);

	await test262RunBatch(files, workerId);

	port.postMessage({
		type: "batchDone",
		results: files.map((file) => ({ path: file.path, result: file.result })),
		processed: files.length,
	});
}

port.postMessage({ type: "ready" });
