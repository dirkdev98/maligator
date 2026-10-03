import { parentPort, workerData } from "node:worker_threads";

const mode = workerData.mode;

if (mode === "quota-startup") {
	parentPort.postMessage({
		length: workerData.buffer.byteLength,
		byte: new Uint8Array(workerData.buffer)[0],
	});
	parentPort.close();
}

function fail() {
	if (mode === "undefined") throw undefined;
	if (mode === "object") throw { marker: 42 };
	if (mode === "uncloneable") throw () => {};
	if (mode === "quota") {
		const buffer = new ArrayBuffer(17 * 1024 * 1024);
		parentPort.postMessage(buffer, [buffer]);
		return;
	}
	throw new Error(`${mode}-failure`);
}

function queueThenThrow() {
	Promise.resolve().then(() => 17);
	fail();
}

if (mode === "startup") {
	parentPort.postMessage("before");
	Promise.resolve().then(fail);
}

parentPort.on("message", (message) => {
	if (mode === "large") {
		if (new Uint8Array(workerData.startup)[0] !== 77)
			throw new Error("startup backing lost");
		const { round, buffer, shared } = message;
		const bytes = new Uint8Array(buffer);
		bytes[0] = round;
		bytes[bytes.length - 1] = round ^ 0xaa;
		const sharedView = new Int32Array(shared);
		Atomics.add(sharedView, 0, 1);
		const items = Array.from({ length: 64 }, () => ({
			head: new Uint8Array(buffer, 0, 4),
			tail: new DataView(buffer, buffer.byteLength - 4, 4),
			shared: sharedView,
		}));
		parentPort.postMessage({ buffer, shared: sharedView, items }, [buffer]);
		if (buffer.byteLength !== 0) throw new Error("worker post did not detach");
		if (round === 8) parentPort.close();
		return;
	}
	if (mode.startsWith("handled-")) {
		const rejected = Promise.reject(new Error("handled"));
		const recover = () => {
			parentPort.postMessage("recovered");
			parentPort.close();
		};
		if (mode === "handled-sync") rejected.catch(recover);
		else Promise.resolve().then(() => rejected.catch(recover));
		return;
	}
	if (mode === "startup") return;
	parentPort.postMessage("before");
	if (mode === "microtask") queueMicrotask(queueThenThrow);
	else if (mode === "timer") setTimeout(queueThenThrow, 0);
	else if (mode === "port") queueThenThrow();
	else Promise.resolve().then(fail);
});
