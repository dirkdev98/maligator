import { Worker, MessageChannel, createWorkerUrl } from "maligator:workers";

function check(value, message) {
	if (!value) throw new Error(message);
}

const worker = new Worker(createWorkerUrl("./worker.mjs", import.meta.url));
const channel = new MessageChannel();
const bound = new SharedArrayBuffer(4);
let responseTimeout;
try {
	worker.port.start();
	await worker.ready;
	channel.port2.onmessage = () => {
		throw new Error("old owner received a transferred port's message");
	};
	for (const value of [1, 2, 3]) channel.port1.postMessage(value);
	const response = new Promise((resolve, reject) => {
		responseTimeout = setTimeout(
			() => reject(new Error("transferred port did not drain")),
			10_000,
		);
		worker.port.addEventListener(
			"message",
			(event) => {
				clearTimeout(responseTimeout);
				resolve(event.data);
			},
			{ once: true },
		);
	});
	worker.port.postMessage({ port: channel.port2, bound }, [channel.port2]);
	const signal = new Int32Array(bound);
	const deadline = Date.now() + 10_000;
	while (Atomics.load(signal, 0) === 0 && Date.now() < deadline) {}
	check(Atomics.load(signal, 0) === 1, "receiver bound transferred port");
	check(
		JSON.stringify(await response) === "[1,2,3]",
		"queued messages preserve FIFO after transfer",
	);
} finally {
	clearTimeout(responseTimeout);
	channel.port1.close();
	channel.port2.close();
	await worker.terminate();
}
console.log("worker-ready-transfer PASS");
