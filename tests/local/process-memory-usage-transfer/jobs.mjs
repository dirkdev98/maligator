import { parentPort } from "node:worker_threads";

if (parentPort === null) throw new Error("worker requires a parent port");
let held;

parentPort.on("message", (message) => {
	if (message.kind === "usage") {
		parentPort.postMessage({ kind: "usage", bytes: process.memoryUsage().arrayBuffers });
		return;
	}
	if (message.kind === "take") {
		if (held !== undefined) throw new Error("worker already holds a buffer");
		held = message.buffer;
		const bytes = new Uint8Array(held);
		if (bytes.length !== 4096 || bytes[0] !== 0x41 || bytes[4095] !== 0x7e)
			throw new Error("transferred backing changed");
		bytes[1] = 0x62;
		const usage = process.memoryUsage().arrayBuffers;
		if (held.byteLength !== 4096 || bytes[1] !== 0x62)
			throw new Error("worker backing lost during measurement");
		parentPort.postMessage({ kind: "owned", bytes: usage });
		return;
	}
	if (message.kind === "return") {
		if (held === undefined) throw new Error("worker has no buffer to return");
		const buffer = held;
		parentPort.postMessage({ kind: "returned", buffer }, [buffer]);
		if (buffer.byteLength !== 0) throw new Error("worker backing did not detach");
		held = undefined;
		return;
	}
	throw new Error(`unknown request: ${message.kind}`);
});
