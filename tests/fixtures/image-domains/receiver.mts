import type { WorkerUrl } from "maligator:workers";
import { parentPort, Worker } from "maligator:workers";
import type { GenerationResult } from "./types.ts";

if (parentPort === null) throw new Error("worker requires a parent port");
const port = parentPort;
async function respond(url: WorkerUrl) {
	const worker = new Worker(url);
	await worker.ready;
	const response = new Promise<GenerationResult>((resolve) => {
		worker.port.addEventListener(
			"message",
			(message) => resolve((message as MessageEvent<GenerationResult>).data),
			{
				once: true,
			},
		);
	});
	worker.port.postMessage("leaf");
	const result = await response;
	await worker.terminate();
	port.postMessage(result);
}
port.onmessage = (event) => {
	void respond(event.data as WorkerUrl);
};
port.start();
