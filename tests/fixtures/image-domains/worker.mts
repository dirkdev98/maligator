import { createWorkerUrl, parentPort, Worker } from "maligator:workers";
import type { GenerationResult } from "./types.ts";

const generation = "first";
if (parentPort === null) throw new Error("worker requires a parent port");
const port = parentPort;
const leafUrl = createWorkerUrl("./leaf.mts", import.meta.url);

async function respond(command: unknown) {
	const child = new Worker(leafUrl);
	await child.ready;
	if (command === "park-child") {
		port.postMessage(generation);
		return;
	}
	const response = new Promise<string>((resolve) => {
		child.port.addEventListener(
			"message",
			(message) => resolve((message as MessageEvent<string>).data),
			{
				once: true,
			},
		);
	});
	child.port.postMessage("generation");
	const leaf = await response;
	await child.terminate();
	port.postMessage({ worker: generation, leaf } satisfies GenerationResult);
}
port.onmessage = (event) => {
	void respond(event.data);
};
port.start();
