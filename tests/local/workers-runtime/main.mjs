import {
	Worker,
	MessageChannel,
	receiveMessageOnPort,
	createWorkerUrl,
} from "maligator:workers";

const spinUrl = createWorkerUrl("./spin.mjs", import.meta.url);
const exceptionSpinUrl = createWorkerUrl("./exception-spin.mjs", import.meta.url);
const exitUrl = createWorkerUrl("./exit-catch.mjs", import.meta.url);
const startupErrorUrl = createWorkerUrl("./startup-error.mjs", import.meta.url);

async function nonAllocatingLoopTerminates(url = spinUrl, label = "spin:") {
	const worker = new Worker(url);
	const started = new Promise((resolve) => {
		worker.port.onmessage = (event) => resolve(event.data);
	});
	await worker.ready;
	if ((await started) !== "spinning") throw new Error("Worker did not enter its loop");
	const first = await worker.terminate();
	const second = await worker.terminate();
	const closed = await worker.closed;
	console.log(
		label,
		JSON.stringify([first.reason, first.code, first === second, first === closed]),
	);
}

async function caughtExitCannotContinue() {
	const worker = new Worker(exitUrl);
	const messages = [];
	worker.port.onmessage = (event) => messages.push(event.data);
	const exit = await worker.closed;
	console.log("exit:", JSON.stringify([exit.reason, exit.code, messages]));
}

async function startupErrorRejectsReady() {
	const worker = new Worker(startupErrorUrl);
	let readyError = "fulfilled";
	try {
		await worker.ready;
	} catch (error) {
		readyError = error instanceof Error ? error.message : String(error);
	}
	const exit = await worker.closed;
	console.log("startup:", JSON.stringify([readyError, exit.reason, exit.code]));
}

function standaloneChannelBoundsAndDiscard() {
	const { port1, port2 } = new MessageChannel({
		maxQueuedMessages: 2,
		maxQueuedBytes: 1 << 20,
	});
	const a = port1.postMessage("a");
	const b = port1.postMessage("b");
	let full = "accepted";
	try {
		port1.postMessage("c");
	} catch (error) {
		full = error.name;
	}
	const foreign = port2._discard(a);
	const discarded = port1._discard(a);
	const again = port1._discard(a);
	const afterDiscard = port1.postMessage("d");
	const received = [];
	for (let entry; (entry = receiveMessageOnPort(port2)) !== undefined;)
		received.push(entry.message);
	const late = port1._discard(b);
	console.log(
		"channel:",
		JSON.stringify([
			typeof a,
			a !== b,
			full,
			foreign,
			discarded,
			again,
			typeof afterDiscard,
			received,
			late,
		]),
	);
	port1.close();
}

standaloneChannelBoundsAndDiscard();
await nonAllocatingLoopTerminates();
await nonAllocatingLoopTerminates(exceptionSpinUrl, "exception-spin:");
await caughtExitCannotContinue();
await startupErrorRejectsReady();
