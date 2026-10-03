import { fileURLToPath } from "node:url";
import { Worker, MessageChannel, receiveMessageOnPort } from "node:worker_threads";
import {
	createWorkerUrl,
	Worker as RawWorker,
	MessageChannel as RawChannel,
} from "maligator:workers";

const entry = createWorkerUrl("./worker.mjs", import.meta.url);
const mib = 1024 * 1024;

function check(value, message) {
	if (!value) throw new Error(message);
}

function queueOptions() {
	return {
		get maxQueuedMessages() {
			throw new Error("Node read a raw count option");
		},
		get maxQueuedBytes() {
			throw new Error("Node read a raw byte option");
		},
		get maxMessageBytes() {
			throw new Error("Node read a raw message option");
		},
	};
}

async function largeTransfers() {
	const startup = new ArrayBuffer(17 * mib);
	new Uint8Array(startup)[0] = 77;
	const shared = new SharedArrayBuffer(4);
	const options = queueOptions();
	options.workerData = { mode: "large", startup };
	options.transferList = [startup];
	const worker = new Worker(fileURLToPath(entry.href), options);
	check(startup.byteLength === 0, "workerData transfer did not detach");
	const exit = new Promise((resolve, reject) => {
		worker.once("exit", resolve);
		worker.once("error", reject);
	});
	let buffer = new ArrayBuffer(80 * mib);
	for (let round = 1; round <= 8; round++) {
		const response = new Promise((resolve) => worker.once("message", resolve));
		worker.postMessage({ round, buffer, shared }, [buffer]);
		check(buffer.byteLength === 0, "parent post did not detach");
		const reply = await response;
		buffer = reply.buffer;
		check(buffer.byteLength === 80 * mib, "large backing length changed");
		for (const item of reply.items) {
			check(
				item.head.buffer === buffer && item.tail.buffer === buffer,
				"views lost their unique backing",
			);
			check(
				item.head.byteOffset === 0 && item.head.byteLength === 4,
				"head view bounds changed",
			);
			check(
				item.tail.byteOffset === buffer.byteLength - 4 && item.tail.byteLength === 4,
				"tail view bounds changed",
			);
			check(
				item.head[0] === round && item.tail.getUint8(3) === (round ^ 0xaa),
				"transferred bytes changed",
			);
			check(
				item.shared === reply.shared && Atomics.load(item.shared, 0) === round,
				"shared backing changed",
			);
		}
		check(
			Atomics.load(new Int32Array(shared), 0) === round,
			"shared updates were copied",
		);
	}
	check((await exit) === 0, "large worker failed");
	console.log("large-transfers PASS");
}

async function quotaPreservesOwnership() {
	const first = new MessageChannel(queueOptions());
	const second = new MessageChannel();
	const buffers = [
		new ArrayBuffer(200 * mib),
		new ArrayBuffer(200 * mib),
		new ArrayBuffer(200 * mib),
	];
	for (let i = 0; i < buffers.length; i++) new Uint8Array(buffers[i])[0] = i + 1;
	first.port1.postMessage(buffers[0], [buffers[0]]);
	second.port1.postMessage(buffers[1], [buffers[1]]);
	let error;
	try {
		first.port1.postMessage(buffers[2], [buffers[2]]);
	} catch (caught) {
		error = caught;
	}
	check(
		error instanceof RangeError && buffers[2].byteLength === 200 * mib,
		"process quota detached rejected ownership",
	);
	check(new Uint8Array(buffers[2])[0] === 3, "rejected bytes changed");
	error = undefined;
	try {
		new Worker(fileURLToPath(entry.href), {
			workerData: { mode: "quota-startup", buffer: buffers[2] },
			transferList: [buffers[2]],
		});
	} catch (caught) {
		error = caught;
	}
	check(
		error instanceof RangeError && buffers[2].byteLength === 200 * mib,
		"workerData bypassed the process budget or detached rejected ownership",
	);
	check(
		new Uint8Array(receiveMessageOnPort(first.port2).message)[0] === 1,
		"first admitted transfer changed",
	);
	first.port1.postMessage(buffers[2], [buffers[2]]);
	check(buffers[2].byteLength === 0, "receive did not release process admission");
	check(
		new Uint8Array(receiveMessageOnPort(second.port2).message)[0] === 2 &&
			new Uint8Array(receiveMessageOnPort(first.port2).message)[0] === 3,
		"retry changed ordering or bytes",
	);
	first.port1.close();
	second.port1.close();
	const raw = new RawChannel({ maxMessageBytes: 1024 });
	const retained = new ArrayBuffer(2048);
	error = undefined;
	try {
		raw.port1.postMessage(retained, [retained]);
	} catch (caught) {
		error = caught;
	}
	check(
		error instanceof RangeError && retained.byteLength === 2048,
		"raw message quota detached ownership",
	);
	raw.port1.close();
	error = undefined;
	try {
		new RawWorker(entry, { data: retained, transfer: [retained], maxMessageBytes: 1024 });
	} catch (caught) {
		error = caught;
	}
	check(
		error instanceof RangeError && retained.byteLength === 2048,
		"raw workerData bypassed its message quota",
	);
	const startup = new ArrayBuffer(200 * mib);
	new Uint8Array(startup)[0] = 99;
	const accepted = new Worker(fileURLToPath(entry.href), {
		workerData: { mode: "quota-startup", buffer: startup },
		transferList: [startup],
	});
	const reply = new Promise((resolve, reject) => {
		accepted.once("message", resolve);
		accepted.once("error", reject);
	});
	const exit = new Promise((resolve) => accepted.once("exit", resolve));
	check(startup.byteLength === 0, "released constructor quota did not admit transfer");
	const value = await reply;
	check(
		value.byte === 99 && value.length === 200 * mib && (await exit) === 0,
		"admitted workerData changed",
	);
	console.log("quota-ownership PASS");
}

async function asyncErrors() {
	for (const mode of [
		"startup",
		"promise",
		"microtask",
		"timer",
		"port",
		"handled-sync",
		"handled-later",
	]) {
		const events = [];
		const worker = new Worker(fileURLToPath(entry.href), { workerData: { mode } });
		const exited = new Promise((resolve) =>
			worker.once("exit", (code) => {
				events.push(`exit:${code}`);
				resolve();
			}),
		);
		worker.on("error", (error) => events.push(`error:${error.message}`));
		worker.on("message", (message) => events.push(message));
		worker.postMessage("go");
		await exited;
		const expected = mode.startsWith("handled-")
			? ["recovered", "exit:0"]
			: ["before", `error:${mode}-failure`, "exit:1"];
		check(
			JSON.stringify(events) === JSON.stringify(expected),
			`${mode}: ${JSON.stringify(events)}`,
		);
	}
	console.log("async-errors PASS");
}

async function rawErrors() {
	for (const mode of ["undefined", "object", "uncloneable", "quota"]) {
		const worker = new RawWorker(entry, { data: { mode } });
		worker.ready.catch(() => {});
		const errors = [];
		worker.addEventListener("error", (event) => errors.push(event.error));
		worker.port.postMessage("go");
		const exit = await worker.closed;
		check(
			exit.reason === "error" &&
				exit.code === 1 &&
				"error" in exit &&
				errors.length === 1,
			`${mode}: raw failure did not settle exactly once`,
		);
		check(errors[0] === exit.error, "raw failure changed reason identity");
		if (mode === "undefined") check(exit.error === undefined, "undefined rejection lost");
		if (mode === "object") check(exit.error.marker === 42, "object rejection lost");
		if (mode === "uncloneable")
			check(typeof exit.error === "string", "uncloneable failure fallback lost");
		if (mode === "quota")
			check(exit.error instanceof RangeError, "async quota failure lost");
	}
	console.log("raw-errors PASS");
}

const mode = process.argv[2];
if (mode === "large") await largeTransfers();
else if (mode === "quota") await quotaPreservesOwnership();
else if (mode === "async") await asyncErrors();
else if (mode === "raw") await rawErrors();
else throw new Error(`unknown test mode: ${mode}`);
