import process from "node:process";
import { isMainThread, threadId, parentPort, workerData } from "node:worker_threads";
import { ready } from "maligator:application";
import { createWorkerUrl, Worker } from "maligator:workers";
const generation = "first";

const data = mal._applicationData();
if (data.mode === "reject") await Promise.reject(new Error("application TLA rejected"));
if (data.mode === "unresolved") await new Promise(() => {});
if (data.mode === "exit") process.exit(7);
if (data.mode === "throw-result") {
	mal._applicationResult("before throw");
	throw new Error("after result");
}
globalThis.launchCount = (globalThis.launchCount || 0) + 1;
const url = createWorkerUrl("./worker.mjs", import.meta.url);
const child = new Worker(url);
await child.ready;
const childResult = new Promise((resolve) =>
	child.port.addEventListener("message", (event) => resolve(event.data), { once: true }),
);
child.port.postMessage(null);
const response = await Promise.race([
	childResult,
	child.closed.then((exit) => {
		throw (
			exit.error || new Error(`child exited without a response ${JSON.stringify(exit)}`)
		);
	}),
]);
setInterval(() => {}, 1000);
setInterval(() => {
	if (Atomics.load(new Int32Array(data.gate), 0) === 0) return;
	if (ready() !== true || ready() !== true)
		throw new Error("application readiness must be idempotent");
	if (data.mode === "park") return;
	mal._applicationResult(
		data.mode === "undefined"
			? undefined
			: {
					generation,
					child: response,
					main: isMainThread,
					threadId,
					parentPort,
					workerData,
					argv: process.argv,
					count: globalThis.launchCount,
					order: globalThis.fragmentOrder,
					data,
					resources: mal._applicationResources(),
					url,
				},
	);
}, 10);
