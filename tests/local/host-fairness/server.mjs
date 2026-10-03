import { MessageChannel } from "node:worker_threads";

const { port1, port2 } = new MessageChannel();
let pendingCheckpoint = false;
let stopped = false;
port2.on("message", () => {
	if (pendingCheckpoint)
		throw new Error("reactor Promise must precede another macrotask");
	if (stopped) {
		port1.close();
		port2.close();
	} else port1.postMessage(0);
});
port1.postMessage(0);

const server = Mal.serve({
	port: 0,
	fetch() {
		pendingCheckpoint = true;
		Promise.resolve().then(() => {
			pendingCheckpoint = false;
			stopped = true;
		});
		return new Response("checkpoint");
	},
});
console.log("PORT " + server.port);
