import { Worker } from "node:worker_threads";
import { createWorkerUrl } from "maligator:workers";

function check(value, message) {
	if (!value) throw new Error(message);
}

function exchange(worker, message, transferList = []) {
	return new Promise((resolve, reject) => {
		function cleanup() {
			worker.off("message", onMessage);
			worker.off("error", onError);
			worker.off("exit", onExit);
		}
		function onMessage(value) {
			cleanup();
			resolve(value);
		}
		function onError(error) {
			cleanup();
			reject(error);
		}
		function onExit(code) {
			cleanup();
			reject(new Error(`worker exited before reply: ${code}`));
		}
		worker.once("message", onMessage);
		worker.once("error", onError);
		worker.once("exit", onExit);
		try {
			worker.postMessage(message, transferList);
		} catch (error) {
			cleanup();
			reject(error);
		}
	});
}

const worker = new Worker(createWorkerUrl("./jobs.mjs", import.meta.url).href);
try {
	const initial = await exchange(worker, { kind: "usage" });
	check(initial.kind === "usage", "worker baseline response");
	const workerBaseline = initial.bytes;
	const mainBaseline = process.memoryUsage().arrayBuffers;
	const source = new ArrayBuffer(4096);
	const bytes = new Uint8Array(source);
	bytes[0] = 0x41;
	bytes[4095] = 0x7e;
	check(process.memoryUsage().arrayBuffers === mainBaseline + 4096, "main owns source");

	const received = await exchange(worker, { kind: "take", buffer: source }, [source]);
	check(source.byteLength === 0, "main source detached on transfer");
	check(
		received.kind === "owned" && received.bytes === workerBaseline + 4096,
		"worker gained transferred capacity",
	);
	check(
		process.memoryUsage().arrayBuffers === mainBaseline,
		"main released transferred capacity",
	);

	const reply = await exchange(worker, { kind: "return" });
	check(
		reply.kind === "returned" && reply.buffer.byteLength === 4096,
		"returned buffer length",
	);
	const returned = reply.buffer;
	check(
		process.memoryUsage().arrayBuffers === mainBaseline + 4096,
		"main regained returned capacity",
	);
	const released = await exchange(worker, { kind: "usage" });
	check(
		released.kind === "usage" && released.bytes === workerBaseline,
		"worker released returned capacity",
	);
	const result = new Uint8Array(returned);
	check(
		result[0] === 0x41 && result[1] === 0x62 && result[4095] === 0x7e,
		"returned backing remains live with worker edits",
	);
} finally {
	await worker.terminate();
}
console.log("process-memory-usage-transfer PASS");
