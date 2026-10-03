import { createWorkerUrl, Worker } from "maligator:workers";

const entry = createWorkerUrl("./echo.ts", import.meta.url);
const worker = new Worker<string, string>(entry);

try {
	const reply = new Promise<string>((resolve) => {
		worker.port.onmessage = (event) => resolve(event.data);
	});
	worker.port.start();
	await worker.ready;
	worker.port.postMessage("workers");
	console.log(await reply);
} finally {
	const exit = await worker.terminate();
	console.log(exit.reason);
}
