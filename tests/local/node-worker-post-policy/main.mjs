import {
	MessageChannel as NodeChannel,
	MessagePort as NodePort,
	Worker,
	receiveMessageOnPort,
} from "node:worker_threads";
import {
	MessageChannel as RawChannel,
	MessagePort as RawPort,
	createWorkerUrl,
} from "maligator:workers";

const workerEntry = createWorkerUrl("./worker.mjs", import.meta.url);

function check(value, message) {
	if (!value) throw new Error(message);
}

function throwsName(callback, name) {
	let error;
	try {
		callback();
	} catch (caught) {
		error = caught;
	}
	check(error?.name === name, `expected ${name}, got ${error?.name}`);
}

function closeDuringClone(Channel, closePeer, expectedBytes, post) {
	const { port1, port2 } = new Channel();
	const buffer = new ArrayBuffer(8);
	const value = {
		buffer,
		get close() {
			(closePeer ? port2 : port1).close();
			return true;
		},
	};
	check(
		(post ?? port1.postMessage).call(port1, value, [buffer]) === undefined,
		"a dropped post returns undefined",
	);
	check(buffer.byteLength === expectedBytes, "getter-close transfer policy");
	check(receiveMessageOnPort(port2) === undefined, "getter-close delivered a message");
}

function moveCallerDuringClone(Channel, expectedBytes) {
	const { port1, port2 } = new Channel();
	const carrier = new RawChannel();
	const buffer = new ArrayBuffer(8);
	port1.postMessage(
		{
			buffer,
			get move() {
				carrier.port1.postMessage(port1, [port1]);
				return true;
			},
		},
		[buffer],
	);
	check(buffer.byteLength === expectedBytes, "moved caller transfer policy");
	check(receiveMessageOnPort(port2) === undefined, "moved caller delivered a message");
	const moved = receiveMessageOnPort(carrier.port2).message;
	check(
		moved instanceof (Channel === NodeChannel ? NodePort : RawPort),
		"moved caller prototype",
	);
	moved.close();
	carrier.port1.close();
}

function transferPolicy(Channel, Carrier, Port, expectedBytes) {
	const { port1, port2 } = new Channel();
	const carrier = new Carrier();
	carrier.port1.postMessage(port1, [port1]);
	const moved = receiveMessageOnPort(carrier.port2).message;
	check(moved instanceof Port && moved.constructor === Port, "transferred port identity");
	const buffer = new ArrayBuffer(8);
	moved.postMessage(
		{
			buffer,
			get close() {
				moved.close();
				return true;
			},
		},
		[buffer],
	);
	check(buffer.byteLength === expectedBytes, "carrier changed transferred port policy");
	check(receiveMessageOnPort(port2) === undefined, "closed transferred port delivered");
	carrier.port1.close();
}

function failedSerializationPreservesTransfers(Channel) {
	for (const invalidPort of [false, true]) {
		const { port1, port2 } = new Channel();
		const transferable = new Channel();
		const buffer = new ArrayBuffer(8);
		const value = {
			buffer,
			get close() {
				port1.close();
				transferable.port1.close();
				return invalidPort ? true : () => {};
			},
		};
		const transfer = invalidPort ? [buffer, transferable.port1] : [buffer];
		throwsName(() => port1.postMessage(value, transfer), "DataCloneError");
		check(buffer.byteLength === 8, "failed serialization detached a buffer");
		check(receiveMessageOnPort(port2) === undefined, "failed serialization delivered");
	}
}

function nodeQueueFailurePreservesTransfers() {
	const { port1, port2 } = new NodeChannel();
	for (let index = 0; index < 65536; index++) {
		check(port1.postMessage(index) === undefined, "Node post leaked its native ticket");
	}
	const buffer = new ArrayBuffer(8);
	let getterCalls = 0;
	throwsName(
		() =>
			port1.postMessage(
				{
					get value() {
						getterCalls++;
						return buffer;
					},
				},
				[buffer],
			),
		"RangeError",
	);
	check(buffer.byteLength === 8 && getterCalls === 0, "quota rejection consumed input");
	for (let index = 0; index < 65536; index++) {
		check(receiveMessageOnPort(port2).message === index, "queue ordering changed");
	}
	check(port1.postMessage(buffer, [buffer]) === undefined, "Node accepted post return");
	check(
		buffer.byteLength === 0 && receiveMessageOnPort(port2).message.byteLength === 8,
		"quota release did not permit transfer",
	);
	port1.close();
}

const node = new NodeChannel({
	get maxQueuedMessages() {
		throw new Error("Node MessageChannel must ignore constructor options");
	},
});
const raw = new RawChannel();
check(
	NodeChannel !== RawChannel && NodePort !== RawPort,
	"API constructor identities overlap",
);
check(
	node instanceof NodeChannel && raw instanceof RawChannel,
	"channel prototype identity",
);
check(
	node.port1 instanceof NodePort && !(node.port1 instanceof RawPort),
	"Node port prototype",
);
check(
	raw.port1 instanceof RawPort && !(raw.port1 instanceof NodePort),
	"raw port prototype",
);
check(
	node.port1.ref() === undefined && node.port1.unref() === undefined,
	"Node port ref return",
);
check(
	raw.port1.ref() === raw.port1 && raw.port1.unref() === raw.port1,
	"raw port ref return",
);
check(typeof raw.port1.postMessage(1) === "number", "raw internal ticket disappeared");
check(receiveMessageOnPort(raw.port2).message === 1, "raw internal post failed");
node.port1.close();
raw.port1.close();
check(
	node.port1.ref() === undefined && node.port1.unref() === undefined,
	"closed Node ref return",
);
throwsName(() => new NodePort(), "TypeError");

for (const closePeer of [false, true]) {
	closeDuringClone(NodeChannel, closePeer, 0);
	closeDuringClone(RawChannel, closePeer, 8);
}
closeDuringClone(NodeChannel, false, 0, RawPort.prototype.postMessage);
closeDuringClone(RawChannel, false, 8, NodePort.prototype.postMessage);
moveCallerDuringClone(NodeChannel, 0);
moveCallerDuringClone(RawChannel, 8);
transferPolicy(NodeChannel, RawChannel, NodePort, 0);
transferPolicy(RawChannel, NodeChannel, RawPort, 8);
failedSerializationPreservesTransfers(NodeChannel);
failedSerializationPreservesTransfers(RawChannel);
nodeQueueFailurePreservesTransfers();

const nodeTransfer = new NodeChannel();
const rawTransfer = new RawChannel();
const worker = new Worker(workerEntry.href, {
	workerData: { node: nodeTransfer.port1, raw: rawTransfer.port1 },
	transferList: [nodeTransfer.port1, rawTransfer.port1],
});
const response = new Promise((resolve, reject) => {
	worker.once("message", resolve);
	worker.once("error", reject);
});
const exited = new Promise((resolve) => worker.once("exit", resolve));
check(
	worker.ref() === worker && worker.unref() === worker && worker.ref() === worker,
	"Worker ref return identity",
);
const buffer = new ArrayBuffer(8);
check(
	worker.postMessage(buffer, [buffer]) === undefined && buffer.byteLength === 0,
	"Node Worker posting contract",
);
check((await response) === "worker-policy PASS", "cross-isolate posting policy");
check((await exited) === 0, "worker exited unsuccessfully");
nodeTransfer.port2.close();
rawTransfer.port2.close();
console.log("node-worker-post-policy PASS");
