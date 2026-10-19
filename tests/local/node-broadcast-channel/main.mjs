import {
	BroadcastChannel,
	MessageChannel,
	MessagePort,
	Worker,
	getEnvironmentData,
	isMarkedAsUntransferable,
	markAsUntransferable,
	setEnvironmentData,
} from "node:worker_threads";

function check(value, message) {
	if (!value) throw new Error(message);
}

function thrown(callback) {
	try {
		callback();
	} catch (error) {
		return error;
	}
	return undefined;
}

for (const [name, value] of [
	["BroadcastChannel", BroadcastChannel],
	["MessageChannel", MessageChannel],
	["MessagePort", MessagePort],
]) {
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
	check(descriptor?.value === value, `${name} global is the module export`);
	check(
		descriptor.writable && descriptor.configurable && !descriptor.enumerable,
		`${name} global attributes`,
	);
}

const marked = new ArrayBuffer(8);
markAsUntransferable(marked);
markAsUntransferable(1);
check(
	isMarkedAsUntransferable(marked) && !isMarkedAsUntransferable({}),
	"untransferable mark",
);
check(
	!isMarkedAsUntransferable(null) && !isMarkedAsUntransferable(1),
	"primitives are not marked",
);
check(!isMarkedAsUntransferable(Object.create(marked)), "mark is not inherited");
check(Object.getOwnPropertySymbols(marked).length === 0, "mark is private");
const markedPorts = new MessageChannel();
const untransferable = thrown(() => markedPorts.port1.postMessage(marked, [marked]));
check(untransferable?.name === "DataCloneError", "marked buffer transfer fails");
check(
	untransferable.message === "Cannot transfer object of unsupported type.",
	untransferable.message,
);
check(
	thrown(() => structuredClone(marked, { transfer: [marked] }))?.name ===
		"DataCloneError",
	"structuredClone",
);
markedPorts.port1.postMessage(marked);
check(
	marked.byteLength === 8 && structuredClone(marked).byteLength === 8,
	"marked buffer still clones",
);
markAsUntransferable(markedPorts.port2);
const markedPort = thrown(() => markedPorts.port1.postMessage(null, [markedPorts.port2]));
check(markedPort?.name === "DataCloneError", "marked port transfer fails");
markedPorts.port1.close();

setEnvironmentData("shared", { count: 1 });
setEnvironmentData("gone", 1);
setEnvironmentData("gone", undefined);
check(
	getEnvironmentData("shared").count === 1 && getEnvironmentData("gone") === undefined,
	"environment data",
);
check(
	setEnvironmentData.length === 2 && getEnvironmentData.length === 1,
	"environment data arity",
);

check(
	Object.getPrototypeOf(BroadcastChannel.prototype) === EventTarget.prototype,
	"EventTarget subclass",
);
check(BroadcastChannel.length === 1, "constructor length");
const missing = thrown(() => new BroadcastChannel());
check(
	missing?.code === "ERR_MISSING_ARGS" && missing instanceof TypeError,
	"missing name",
);
check(
	missing.message === 'The "name" argument must be specified',
	"missing name message",
);
const invalid = thrown(() => BroadcastChannel.prototype.close.call({}));
check(invalid?.code === "ERR_INVALID_THIS", "invalid this");
check(
	invalid.message === 'Value of "this" must be of type BroadcastChannel',
	"invalid this message",
);

const self = new BroadcastChannel(42);
check(self.name === "42", "name is stringified");
const enumerable = Object.keys(
	Object.getOwnPropertyDescriptors(BroadcastChannel.prototype),
).filter(
	(key) => Object.getOwnPropertyDescriptor(BroadcastChannel.prototype, key).enumerable,
);
check(
	enumerable.join() === "name,close,postMessage,onmessage,onmessageerror",
	`enumerable ${enumerable}`,
);
const uncloneable = thrown(() => self.postMessage(() => 1));
check(uncloneable?.name === "DataCloneError", "function is not cloneable");
check(thrown(() => self.postMessage())?.code === "ERR_MISSING_ARGS", "missing message");
check(self.ref() === self && self.unref() === self, "ref/unref return this");
self.close();
self.close();
const closed = thrown(() => self.postMessage(1));
check(
	closed?.name === "InvalidStateError" &&
		closed.message === "BroadcastChannel is closed.",
	"closed post",
);
check(self.ref() === self, "ref after close");

const first = new BroadcastChannel("local");
const second = new BroadcastChannel("local");
const other = new BroadcastChannel("other");
other.onmessage = () => {
	throw new Error("other channel must not receive");
};
const firstSeen = [];
first.onmessage = (event) => firstSeen.push(event.data);
const received = await new Promise((resolve) => {
	second.addEventListener("message", (event) => {
		check(event.type === "message" && event instanceof Event, "message event");
		check(event.target === second, "event target");
		resolve(event.data);
	});
	first.postMessage({ value: [1, 2, 3], when: new Map([["a", 1]]) });
});
check(received.value.join() === "1,2,3" && received.when.get("a") === 1, "local clone");
check(firstSeen.length === 0, "sender does not receive its own message");
other.close();

const workerReplies = [];
const done = new Promise((resolve) => {
	first.onmessage = (event) => {
		workerReplies.push(event.data);
		if (event.data === "worker ready") second.postMessage("from main");
		if (event.data === "worker got from main") resolve();
	};
});
const worker = new Worker(new URL("./worker.mjs", import.meta.url));
setEnvironmentData("late", true);
const exited = new Promise((resolve) => worker.once("exit", resolve));
await done;
await exited;
check(
	workerReplies.join("|") ===
		'env {"shared":1,"gone":false,"late":false}|worker ready|from main|worker got from main',
	`worker replies ${workerReplies}`,
);
check(
	getEnvironmentData("worker") === undefined,
	"worker environment changes stay in the worker",
);

const lateEvents = [];
worker.on("exit", () => lateEvents.push("exit"));
worker.once("custom", (value) => lateEvents.push(`custom ${value}`));
check(
	worker.listenerCount("exit") === 1 && worker.listenerCount("custom") === 1,
	"listeners after exit",
);
check(worker.emit("custom", 7) && !worker.emit("custom", 8), "emit after exit");
worker.removeAllListeners("exit");
check(
	worker.listenerCount("exit") === 0 && lateEvents.join() === "custom 7",
	`late events ${lateEvents}`,
);

second.close();
first.postMessage("after close of second");
first.close();
const lingering = new BroadcastChannel("lingering");
lingering.unref();
console.log("node-broadcast-channel PASS");
