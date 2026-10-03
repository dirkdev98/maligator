import { createWorkerUrl, Worker } from "maligator:workers";

const entry = createWorkerUrl("./worker-data.ts", import.meta.url);
const worker = new Worker(entry, { data: { label: "thumbnail" } });
try {
	await worker.ready;
	const exit = await worker.closed;
	if (exit.code !== 0) throw new Error("Worker failed");
} finally {
	await worker.terminate();
}
