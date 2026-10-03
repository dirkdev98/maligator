import { MessageChannel } from "node:worker_threads";

const { port1, port2 } = new MessageChannel();
let pendingCheckpoint = false;
let completeRequest;
port2.on("message", () => {
	if (pendingCheckpoint)
		throw new Error("reactor Promise must precede another macrotask");
	if (completeRequest !== undefined) {
		port1.close();
		port2.close();
		completeRequest(new Response("checkpoint"));
		completeRequest = undefined;
	} else port1.postMessage(0);
});
port1.postMessage(0);

const server = Mal.serve({
	port: 0,
	fetch() {
		pendingCheckpoint = true;
		Promise.resolve().then(() => {
			pendingCheckpoint = false;
		});
		return new Promise((resolve) => {
			completeRequest = resolve;
		});
	},
});
console.log("PORT " + server.port);
