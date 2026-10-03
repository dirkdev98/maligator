import { parentPort } from "maligator:workers";

parentPort.onmessage = (event) => {
	const { port, bound } = event.data;
	const values = [];
	port.onmessage = (message) => {
		values.push(message.data);
		if (values.length === 3) {
			parentPort.postMessage(values);
			port.close();
		}
	};
	const signal = new Int32Array(bound);
	Atomics.store(signal, 0, 1);
	Atomics.notify(signal, 0);
};
