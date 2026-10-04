import { parentPort, Worker } from "maligator:workers";

parentPort.addEventListener("message", async (event) => {
	const worker = new Worker(event.data);
	await worker.ready;
	const response = new Promise((resolve) => {
		worker.port.addEventListener("message", (message) => resolve(message.data), {
			once: true,
		});
	});
	worker.port.postMessage("leaf");
	const result = await response;
	await worker.terminate();
	parentPort.postMessage(result);
});
parentPort.start();
