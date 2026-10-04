import { createWorkerUrl, parentPort, Worker } from "maligator:workers";

const generation = "first";
const leafUrl = createWorkerUrl("./leaf.mjs", import.meta.url);

parentPort.addEventListener("message", async (event) => {
	const child = new Worker(leafUrl);
	await child.ready;
	if (event.data === "park-child") {
		parentPort.postMessage(generation);
		return;
	}
	const response = new Promise((resolve) => {
		child.port.addEventListener("message", (message) => resolve(message.data), {
			once: true,
		});
	});
	child.port.postMessage("generation");
	const leaf = await response;
	await child.terminate();
	parentPort.postMessage({ worker: generation, leaf });
});
parentPort.start();
