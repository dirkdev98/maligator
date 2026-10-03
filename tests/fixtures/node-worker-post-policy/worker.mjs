import { parentPort, workerData, MessagePort } from "node:worker_threads";
import { MessagePort as RawPort } from "maligator:workers";

function check(value, message) {
	if (!value) throw new Error(message);
}

check(
	parentPort instanceof MessagePort && parentPort.constructor === MessagePort,
	"Node worker parentPort identity",
);
check(
	workerData.node instanceof MessagePort && workerData.raw instanceof RawPort,
	"workerData changed transferred port prototypes",
);
check(
	workerData.node.ref() === undefined && workerData.node.unref() === undefined,
	"transferred Node ref return",
);
check(
	workerData.raw.ref() === workerData.raw && workerData.raw.unref() === workerData.raw,
	"transferred raw ref return",
);

for (const [port, expectedBytes] of [
	[workerData.node, 0],
	[workerData.raw, 8],
]) {
	const buffer = new ArrayBuffer(8);
	port.postMessage(
		{
			buffer,
			get close() {
				port.close();
				return true;
			},
		},
		[buffer],
	);
	check(buffer.byteLength === expectedBytes, "workerData changed native posting policy");
}

parentPort.once("message", (buffer) => {
	check(buffer.byteLength === 8, "Node worker received invalid transfer");
	check(
		parentPort.postMessage("worker-policy PASS") === undefined,
		"parentPort leaked ticket",
	);
	parentPort.close();
});
