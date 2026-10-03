import { parentPort, workerData } from "maligator:workers";

parentPort.addEventListener("message", (event) => {
	const message = event.data;
	if (message.port !== undefined) {
		message.port.addEventListener("message", (item) =>
			message.port.postMessage(item.data + workerData.amount),
		);
		message.port.start();
	} else if (message.shared !== undefined) {
		const view = new Int32Array(message.shared);
		view[1] = 19;
		message.shared.grow(24);
		Atomics.store(view, 0, 1);
		Atomics.notify(view, 0);
		parentPort.postMessage({ shared: true });
	} else {
		parentPort.postMessage(
			message,
			message.bytes === undefined ? [] : [message.bytes.buffer],
		);
	}
});
parentPort.start();
