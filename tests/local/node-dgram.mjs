import dgram, { createSocket, Socket } from "node:dgram";
import { once } from "node:events";

const show = (label, error) => console.log(label, error.code, error.name, error.message);

console.log(
	typeof dgram.createSocket,
	typeof Socket,
	createSocket("udp4") instanceof Socket,
);

try {
	createSocket("tcp");
} catch (error) {
	show("bad type", error);
}
try {
	createSocket({});
} catch (error) {
	show("missing type", error);
}

const server = createSocket("udp4");
server.bind(0, "127.0.0.1");
await once(server, "listening");
const { port } = server.address();
console.log(
	"server address",
	server.address().address,
	server.address().family,
	port > 0,
);
try {
	server.bind(0);
} catch (error) {
	show("rebind", error);
}

const client = createSocket({ type: "udp4" });
const received = [];
server.on("message", (msg, rinfo) => {
	received.push(msg.toString());
	if (received.length === 1) {
		console.log(
			"rinfo",
			rinfo.address,
			rinfo.family,
			rinfo.size,
			rinfo.port === client.address().port,
		);
	}
});

const sent = await new Promise((resolve, reject) =>
	client.send("hello", port, "127.0.0.1", (error, bytes) =>
		error ? reject(error) : resolve(bytes),
	),
);
console.log("implicit bind", sent, client.address().address, client.address().port > 0);
while (received.length < 1) await once(server, "message");

client.send([Buffer.from("ab"), new Uint8Array([99, 100]), "ef"], port, "127.0.0.1");
client.send("0123456789", 2, 3, port, "127.0.0.1");
client.send(new DataView(new TextEncoder().encode("view").buffer), port, "127.0.0.1");
while (received.length < 4) await once(server, "message");
console.log("received", received.join("|"));

try {
	client.remoteAddress();
} catch (error) {
	show("not connected", error);
}
client.connect(port, "127.0.0.1");
await once(client, "connect");
console.log(
	"remote",
	client.remoteAddress().address,
	client.remoteAddress().port === port,
);
try {
	client.connect(port);
} catch (error) {
	show("already connected", error);
}
try {
	client.send("x", 0, 1, port, "127.0.0.1");
} catch (error) {
	show("connected send", error);
}
client.send("connected", (error, bytes) =>
	console.log("connected send callback", error, bytes),
);
while (received.length < 5) await once(server, "message");
console.log("connected message", received[4]);
client.disconnect();
try {
	client.disconnect();
} catch (error) {
	show("disconnect twice", error);
}

for (const bad of [-1, 65536, 1.5]) {
	try {
		client.send("x", bad, "127.0.0.1");
	} catch (error) {
		show("bad port", error);
	}
}
try {
	client.send(42, port, "127.0.0.1");
} catch (error) {
	show("bad msg", error);
}

const clash = createSocket("udp4");
clash.on("error", (error) => {
	console.log(
		"clash",
		error.code,
		error.syscall,
		error.errno < 0,
		error.address,
		error.port === port,
	);
	console.log("clash message", error.message === `bind EADDRINUSE 127.0.0.1:${port}`);
});
clash.bind(port, "127.0.0.1");
await once(clash, "error");
clash.close();

console.log(
	"sizes",
	typeof server.getRecvBufferSize(),
	server.getSendQueueSize(),
	server.getSendQueueCount(),
);
server.setBroadcast(true);
server.setTTL(32);
server.setMulticastTTL(4);
server.setMulticastLoopback(true);

const order = [];
client.on("close", () => order.push("close event"));
client.close(() => order.push("close callback"));
order.push("after close");
try {
	client.send("late", port, "127.0.0.1");
} catch (error) {
	show("after close", error);
}
try {
	client.address();
} catch (error) {
	show("address after close", error);
}
await once(client, "close");
await new Promise((resolve) => setImmediate(resolve));
console.log("order", order.join(", "));
try {
	client.close();
} catch (error) {
	show("close twice", error);
}

const sink = createSocket("udp4");
sink.bind(0, "127.0.0.1");
await once(sink, "listening");
const burst = createSocket("udp4");
const payload = Buffer.alloc(8192, 7);
let acknowledged = 0;
let failures = 0;
await new Promise((resolve) => {
	for (let i = 0; i < 256; i++) {
		burst.send(payload, sink.address().port, "127.0.0.1", (error) => {
			if (error) failures++;
			if (++acknowledged === 256) resolve();
		});
	}
});
console.log("burst", acknowledged, failures, burst.getSendQueueCount());
burst.close();
sink.close();

await new Promise((resolve) => server.close(resolve));

// "127.1" is not an IP literal for net.isIP, so it resolves through dns.lookup without the network.
await new Promise((resolve) => {
	const named = createSocket("udp4");
	named.on("message", (message, remote) => {
		console.log("named message", String(message), remote.address);
		named.close(resolve);
	});
	named.bind(0, "127.1", () => {
		console.log("named bound", named.address().address);
		named.send("named-ping", named.address().port, "127.1", (error, bytes) =>
			console.log("named sent", error, bytes),
		);
	});
	named.send("queued", 9, "127.0.0.1", (error) => console.log("queued sent", error));
});

const controller = new AbortController();
const aborted = createSocket({ type: "udp4", signal: controller.signal });
aborted.bind(0, "127.0.0.1");
await once(aborted, "listening");
controller.abort();
await once(aborted, "close");
try {
	createSocket({ type: "udp4", signal: AbortSignal.abort() }).address();
} catch (error) {
	show("pre-aborted", error);
}

// A host holding U+0000 must not bind the text before it.
const nulBind = createSocket("udp4");
try {
	nulBind.bind(0, "127.0.0.1\0x");
	console.log("bind NUL no throw");
} catch (error) {
	console.log("bind NUL", error.name, error.code, JSON.stringify(error.message));
}
nulBind.close();

const idle = createSocket("udp4");
idle.bind(0, "127.0.0.1", () => {
	console.log("idle listening");
	idle.unref();
});
process.on("exit", () => console.log("exit"));
