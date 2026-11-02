/* oxlint-disable no-console -- The fixture reports the worker's C result. */
import { createWorkerUrl, Worker } from "maligator:workers";

const worker = new Worker(createWorkerUrl("./worker.ts", import.meta.url));
const result = new Promise((resolve) => {
	worker.port.onmessage = (event) => resolve(event.data);
});
worker.port.start();
await worker.ready;
worker.port.postMessage(31);
console.log(await result);
await worker.terminate();
