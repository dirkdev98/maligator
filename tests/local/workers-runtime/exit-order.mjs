import { Worker } from "node:worker_threads";
import { createWorkerUrl } from "maligator:workers";

const entry = createWorkerUrl("./exit-order-worker.mjs", import.meta.url);
for (let round = 0; round < 4; round++) {
	const ready = new Int32Array(new SharedArrayBuffer(4));
	const worker = new Worker(entry.href, { workerData: ready.buffer });
	const received = [];
	worker.on("message", (value) => received.push(value));
	const exit = new Promise((resolve, reject) => {
		worker.once("error", reject);
		worker.once("exit", resolve);
	});
	const deadline = performance.now() + 10000;
	while (Atomics.load(ready, 0) === 0) {
		if (performance.now() >= deadline) throw new Error("worker did not publish messages");
	}
	const drainAfter = performance.now() + 50;
	while (performance.now() < drainAfter) {}
	if ((await exit) !== 0) throw new Error("worker failed");
	if (received.length !== 32 || received.some((value, index) => value !== index)) {
		throw new Error("exit overtook posted messages");
	}
}
console.log("exit-order PASS");
