import { MessageChannel as NodeMessageChannel } from "node:worker_threads";
import { MessageChannel, receiveMessageOnPort } from "maligator:workers";

function check(value, message) {
	if (!value) throw new Error(message);
}

async function rawWithoutTransfers() {
	const { port1, port2 } = new MessageChannel();
	try {
		const event = new Promise((resolve) => {
			port2.onmessage = resolve;
		});
		port1.postMessage(7);
		const received = await event;
		check(received.data === 7, "raw message data");
		check(
			Array.isArray(received.ports) && received.ports.length === 0,
			"empty event.ports",
		);
		check(Object.isFrozen(received.ports), "immutable empty event.ports");
	} finally {
		port1.close();
		port2.close();
	}
}

async function rawWithTransferredPort() {
	const { port1, port2 } = new MessageChannel();
	const bridge = new MessageChannel();
	try {
		const event = new Promise((resolve) => {
			port2.onmessage = resolve;
		});
		port1.postMessage("bridge", [bridge.port1]);
		const received = await event;
		check(received.data === "bridge", "transferred message data");
		check(
			received.ports.length === 1 && Object.isFrozen(received.ports),
			"transferred event.ports",
		);
		received.ports[0].postMessage("connected");
		check(
			receiveMessageOnPort(bridge.port2)?.message === "connected",
			"adopted port works",
		);
		received.ports[0].close();
	} finally {
		port1.close();
		port2.close();
		bridge.port2.close();
	}
}

async function nodeWithoutTransfers() {
	const { port1, port2 } = new NodeMessageChannel();
	try {
		const message = new Promise((resolve) => {
			port2.on("message", resolve);
		});
		port1.postMessage({ answer: 42 });
		check((await message).answer === 42, "Node message delivery");
	} finally {
		port1.close();
		port2.close();
	}
}

await rawWithoutTransfers();
await rawWithTransferredPort();
await nodeWithoutTransfers();
console.log("worker-empty-transfers PASS");
