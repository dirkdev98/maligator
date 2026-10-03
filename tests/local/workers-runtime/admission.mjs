import { markAsUncloneable } from "node:worker_threads";
import { MessageChannel, receiveMessageOnPort } from "maligator:workers";

function postError(post) {
	try {
		post();
		return "posted";
	} catch (error) {
		return error.name;
	}
}

// Throwing getters return their reservations, so the process-wide count is exact.
function processQueueLimitIsSharedAndReleased() {
	const { port1: probe } = new MessageChannel();
	for (let i = 0; i < 70_000; i++) {
		postError(() =>
			probe.postMessage({
				get boom() {
					throw new Error("getter");
				},
			}),
		);
	}
	const channels = [];
	let accepted = 0;
	let rejected = "none";
	while (rejected === "none") {
		const channel = new MessageChannel();
		channels.push(channel);
		for (let i = 0; i < 4096; i++) {
			const name = postError(() => channel.port1.postMessage(i));
			if (name !== "posted") {
				rejected = name;
				break;
			}
			accepted++;
		}
	}
	const freed = receiveMessageOnPort(channels[0].port2)?.message;
	const afterReceive = postError(() => channels.at(-1).port1.postMessage("again"));
	let drained = 0;
	for (const { port2 } of channels) {
		while (receiveMessageOnPort(port2) !== undefined) drained++;
	}
	console.log(
		"process-limit:",
		JSON.stringify([accepted, rejected, freed, afterReceive, drained]),
	);
}

function getterClosingPortKeepsTransferredBuffer(closeReceiver) {
	const { port1: sender, port2: receiver } = new MessageChannel();
	const buffer = new ArrayBuffer(8);
	const value = {
		buffer,
		get close() {
			(closeReceiver ? receiver : sender).close();
			return 1;
		},
	};
	const name = postError(() => sender.postMessage(value, [buffer]));
	return [name, buffer.byteLength, receiveMessageOnPort(receiver) === undefined];
}

function uncloneableObjectsRejectClones() {
	const { port1, port2 } = new MessageChannel();
	const marked = { secret: 1 };
	markAsUncloneable(marked);
	markAsUncloneable(marked);
	const primitive = markAsUncloneable(5);
	const nested = postError(() => port1.postMessage({ inner: [marked] }));
	const plain = postError(() => port1.postMessage({ inner: { secret: 1 } }));
	console.log(
		"uncloneable:",
		JSON.stringify([
			nested,
			plain,
			primitive === undefined,
			receiveMessageOnPort(port2)?.message.inner.secret,
			receiveMessageOnPort(port2) === undefined,
		]),
	);
}

processQueueLimitIsSharedAndReleased();
console.log(
	"getter-close-queue:",
	JSON.stringify([
		...getterClosingPortKeepsTransferredBuffer(false),
		...getterClosingPortKeepsTransferredBuffer(true),
	]),
);
uncloneableObjectsRejectClones();
