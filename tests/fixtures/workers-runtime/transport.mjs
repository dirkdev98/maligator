import { MessageChannel, receiveMessageOnPort, createWorkerUrl } from "maligator:workers";

const spinUrl = createWorkerUrl("./spin.mjs", import.meta.url);

function cloneErrorName(post) {
	try {
		post();
		return "posted";
	} catch (error) {
		return error.name;
	}
}

function getterClosingListedPortDetachesNothing() {
	const { port1: sender, port2: receiver } = new MessageChannel();
	const { port1: victim } = new MessageChannel();
	const buffer = new ArrayBuffer(8);
	const value = {
		victim,
		get close() {
			victim.close();
			return 1;
		},
		buffer,
	};
	const name = cloneErrorName(() => sender.postMessage(value, [victim, buffer]));
	console.log(
		"getter-close:",
		JSON.stringify([
			name,
			buffer.byteLength,
			receiveMessageOnPort(receiver) === undefined,
		]),
	);
}

function getterRetransferringListedPortDetachesNothing() {
	const { port1: sender, port2: receiver } = new MessageChannel();
	const { port1: other, port2: otherPeer } = new MessageChannel();
	const { port1: victim } = new MessageChannel();
	const buffer = new ArrayBuffer(8);
	const value = {
		victim,
		get move() {
			other.postMessage("moved", [victim]);
			return 1;
		},
		buffer,
	};
	const name = cloneErrorName(() => sender.postMessage(value, [victim, buffer]));
	console.log(
		"getter-retransfer:",
		JSON.stringify([
			name,
			buffer.byteLength,
			receiveMessageOnPort(receiver) === undefined,
			receiveMessageOnPort(otherPeer)?.message,
		]),
	);
}

function standaloneTransferRoundTrip() {
	const { port1, port2 } = new MessageChannel();
	const inner = new MessageChannel();
	port1.postMessage({ port: inner.port1, url: spinUrl }, [inner.port1]);
	const resent = cloneErrorName(() => port1.postMessage(null, [inner.port1]));
	const { message } = receiveMessageOnPort(port2);
	message.port.postMessage("through");
	const through = receiveMessageOnPort(inner.port2)?.message;
	console.log(
		"roundtrip:",
		JSON.stringify([
			resent,
			through,
			message.port !== inner.port1,
			message.url === spinUrl,
			message.url.href === spinUrl.href,
		]),
	);
}

function abandonedChannelsDoNotPinReservations() {
	const payloadBytes = 4 << 20;
	const before = process.memoryUsage().rss;
	for (let i = 0; i < 400; i++) {
		const { port1 } = new MessageChannel();
		const payload = new ArrayBuffer(payloadBytes);
		port1.postMessage(payload, [payload]);
		// Heap pressure so the collector observes the abandoned wrappers.
		const garbage = [];
		for (let j = 0; j < 2000; j++) garbage.push({ j });
	}
	const grownMiB = (process.memoryUsage().rss - before) / (1 << 20);
	// 400 leaked 4 MiB snapshots would pin 1600 MiB.
	console.log("abandoned:", JSON.stringify([grownMiB < 800]));
}

getterClosingListedPortDetachesNothing();
getterRetransferringListedPortDetachesNothing();
standaloneTransferRoundTrip();
abandonedChannelsDoNotPinReservations();
