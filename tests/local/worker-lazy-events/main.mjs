import { MessageChannel } from "node:worker_threads";

function check(condition, message) {
	if (!condition) throw new Error(message);
}

async function bounded(promise, name) {
	let timer;
	try {
		return await Promise.race([
			promise,
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error(`${name} timed out`)), 2000);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

async function nodeListenerMutation() {
	const { port1, port2 } = new MessageChannel();
	const nodeEvents = [];
	const webEvents = [];
	const webListener = (event) => webEvents.push(`target:${event.data}`);
	const handler = (event) => webEvents.push(`handler:${event.data}`);
	let resolveMessage;
	try {
		port2.on("message", (value) => {
			nodeEvents.push(value);
			if (value === 1) {
				port2.addEventListener("message", webListener);
				port2.onmessage = handler;
			} else if (value === 2) {
				port2.removeEventListener("message", webListener);
				port2.onmessage = null;
			}
			resolveMessage();
		});
		for (const value of [0, 1, 2]) {
			const message = new Promise((resolve) => {
				resolveMessage = resolve;
			});
			port1.postMessage(value);
			await bounded(message, `mutation message ${value}`);
		}
		check(nodeEvents.join() === "0,1,2", "Node-only messages retain FIFO delivery");
		check(
			webEvents.join() === "target:1,handler:1",
			"live web observers follow Node listener edits",
		);
	} finally {
		port1.close();
		port2.close();
	}
}

async function queuedMessagesBeforeClose() {
	const { port1, port2 } = new MessageChannel();
	const events = [];
	try {
		const closed = new Promise((resolve) => {
			port2.on("close", () => {
				events.push("close");
				resolve();
			});
		});
		port2.on("message", (value) => events.push(`message:${value}`));
		port1.postMessage("a");
		port1.postMessage("b");
		port1.close();
		await bounded(closed, "queued messages before close");
		check(
			events.join() === "message:a,message:b,close",
			"queued messages drain FIFO before close",
		);
	} finally {
		port1.close();
		port2.close();
	}
}

async function closeDuringNodeEmission() {
	const { port1, port2 } = new MessageChannel();
	const events = [];
	try {
		const delivered = new Promise((resolve) => {
			port2.addEventListener("message", (event) => {
				events.push(`web:${event.data}`);
				resolve();
			});
		});
		port2.on("message", (value) => {
			events.push(`node:${value}`);
			port2.close();
		});
		port1.postMessage("close");
		await bounded(delivered, "web event after close");
		check(
			events.join() === "node:close,web:close",
			"close retains the in-flight web event",
		);
	} finally {
		port1.close();
		port2.close();
	}
}

async function transferDuringNodeEmission() {
	const source = new MessageChannel();
	const carrier = new MessageChannel();
	const events = [];
	let adopted;
	try {
		const webDelivered = new Promise((resolve) => {
			source.port2.addEventListener("message", (event) => {
				events.push(`web:${event.data}`);
				resolve();
			});
		});
		const handedOff = new Promise((resolve) => {
			carrier.port2.on("message", (value) => {
				adopted = value.port;
				resolve();
			});
		});
		source.port2.on("message", (value) => {
			events.push(`node:${value}`);
			carrier.port1.postMessage({ port: source.port2 }, [source.port2]);
		});
		source.port1.postMessage("move");
		await bounded(webDelivered, "web event after transfer");
		await bounded(handedOff, "port handoff");
		check(
			events.join() === "node:move,web:move",
			"transfer retains the in-flight web event",
		);
		const after = new Promise((resolve) => adopted.on("message", resolve));
		source.port1.postMessage("after");
		check(
			(await bounded(after, "handed-off port message")) === "after",
			"adopted port receives messages",
		);
	} finally {
		adopted?.close();
		source.port1.close();
		source.port2.close();
		carrier.port1.close();
		carrier.port2.close();
	}
}

async function unobservedPortCleanup() {
	const destination = new MessageChannel();
	const bridge = new MessageChannel();
	try {
		const delivered = new Promise((resolve) => destination.port2.on("message", resolve));
		const closed = new Promise((resolve) => bridge.port2.on("close", resolve));
		bridge.port2.start();
		destination.port1.postMessage("unused transfer", [bridge.port1]);
		check(
			(await bounded(delivered, "unobserved transfer")) === "unused transfer",
			"Node-only transfer arrives",
		);
		globalThis.__mal_collect_garbage();
		globalThis.__mal_collect_garbage();
		await bounded(closed, "unobserved transferred port cleanup");
	} finally {
		destination.port1.close();
		destination.port2.close();
		bridge.port1.close();
		bridge.port2.close();
	}
}

await nodeListenerMutation();
await queuedMessagesBeforeClose();
await closeDuringNodeEmission();
await transferDuringNodeEmission();
await unobservedPortCleanup();
console.log("worker-lazy-events PASS");
