// The global WebSocket client against a deterministic RFC 6455 server written on node:net.
import { createHash } from "node:crypto";
import * as net from "node:net";
import * as tls from "node:tls";

// tests/fixtures/tls: the localhost server certificate and key. The wss session expects the
// runner to trust tests/fixtures/tls/localhost-cert.pem through NODE_EXTRA_CA_CERTS.
const CERT = `-----BEGIN CERTIFICATE-----
MIIDPTCCAiWgAwIBAgIUAKMihiwk4GFZURFNOuv3qe1ercswDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDcyNzIwMjExNloXDTM2MDcy
NDIwMjExNlowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEA0C5Nflog96InamL2eDzDqN7nwP+t/RXYmYaHMyteqfQ9
3XQthDJV83CVyOeKKZVdk33Xvz6iAJemAFX1A5O+tUqVSwHnzm485Vl9ft+7zjaf
mZW+Lzl/jELfyzRfgt1BfoRn4cXHW15OWmIxBHYdPp4F22dXYNTeJAkpJrqbA4Xh
3MnLP9VjNKrR2EQoO8lfzRrfAM1edJvA/JJ3K/Fz6GE75MqU/ledAZse6loMuD+F
B3kETySVFbwweEa3zkDnCaSI26YLDP155Dhnrz0E0O0RFmq5nhAZqrINa319eyp/
h4MrMpxgk/4OtK2oF4SvbjhUNhSlqZPd/QCDI2O0XQIDAQABo4GGMIGDMBQGA1Ud
EQQNMAuCCWxvY2FsaG9zdDAJBgNVHRMEAjAAMAsGA1UdDwQEAwIFoDATBgNVHSUE
DDAKBggrBgEFBQcDATAdBgNVHQ4EFgQU2k6PyDIyt5yUfedSSssAZ3eJb9owHwYD
VR0jBBgwFoAUTmWkC3KciaaTX/Ixp1nQ1h71T1MwDQYJKoZIhvcNAQELBQADggEB
ALPzLUWd9J7f86BOo3GI1j+E38rKZ+YDPLFjs7TdHwCfc12yLHfnybvr+0N8WLpI
qodjDGwti/qkDe5ury8dfzrrDK+gtjWyY3e4rLTnARbrHgVvNsU7W8l9Z/Ym6RxJ
tvV4iYTf+s5JxFG5SjDi9AemnB+v9FPlTJtOla2PY3jdSShEZ16h3FfvVffzFnuh
EJ5JoUudcwMdL7Q5zJs9a4uSegyNDbC3EoyvJtu8Fiho5F1YuPg5kcDbsHFqP7vR
pCkYDc5++7/RNlsknlCo5aTDChq8Wg/WsM//3lVsIsDd4nvQsKEzR+j0Hk1Z4062
hcwKmXmF37fwjB2/JO/0WU8=
-----END CERTIFICATE-----
`;
const KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDQLk1+WiD3oidq
YvZ4PMOo3ufA/639FdiZhoczK16p9D3ddC2EMlXzcJXI54oplV2Tfde/PqIAl6YA
VfUDk761SpVLAefObjzlWX1+37vONp+Zlb4vOX+MQt/LNF+C3UF+hGfhxcdbXk5a
YjEEdh0+ngXbZ1dg1N4kCSkmupsDheHcycs/1WM0qtHYRCg7yV/NGt8AzV50m8D8
kncr8XPoYTvkypT+V50Bmx7qWgy4P4UHeQRPJJUVvDB4RrfOQOcJpIjbpgsM/Xnk
OGevPQTQ7REWarmeEBmqsg1rfX17Kn+HgysynGCT/g60ragXhK9uOFQ2FKWpk939
AIMjY7RdAgMBAAECggEALu2FG/qqrE/CBVYWG7AM5hQLV4L7QE4Mo70C3JrF7ddI
G9PMz9w96lDCfwWMrEeGjtEjEXIHuEz3B2PZBauoJXtQ0JX3IF5SvVuRMciy7+75
xrgN5VzXfvFzO74MWrZQBXpI5Yi9IgBN9stkI86RVJRwGw9+T65kfeiPvXJ6r431
qI0P3J7XGorDP3xaSpQG98C6pFA6/rxHbQGdAfsQhpfyYCIAs3kWmeutiluc8jCi
1m5FFhBnnTeOeOo0kf6knxMhv+67q6X6usl/fkGo9lZaDdLvq1scwx/3cENMsYZg
oGnnQ9De9CSx/PFjkRNwASJLp9cURAKbMlYyN2rH0QKBgQD/hOIvaV/PAJWJvcoT
tU2gAnL8f1+kA80Lmldt4acTjxhXcJHSs7H63D0iVnvrbw9s39EJxOql8xDKRy7z
GX1YRBJl6bNfljNi16LxPAt3Guj1f9gk9soJ3jlXjvJNfwhb9sZLQoBghev7hXhD
ebl6GKUeVmYMAGIQy5huPsADbQKBgQDQkpw594TPrEf0RIF1Ff5VH/K7tdznQePK
UyHjTMajx8SlL5J59l1AHimJtKEN65TiwovQpqDI+KuwxBajUJIKBsUL9AgwrOz9
8sgrh5UV2Vf5z8h+lJI7YEa+ArkikSHazl7u5/MXYiRjljh9h/1vFt3B6aIc9m9K
+mPbWfrusQKBgQCj5WODz85ho9lHWdJlo9SfvxJsfXMmbD24pI5R7/zQIegWJiGT
CiouY9hezyR7VmiJiGK4JnPwcCGj7dbincX1uOwoLKgetuRNEU31+HLOOheVaSSG
STo87CrRy+IF7Wa6Pmbg3U4lG6HLWshSV6Ct/WLkO70HE7PTXBRxGpTlXQKBgGqI
F+e7t0hjlLT9MKpfO3K7SL373AL6sqCq6YoxstwAsz40GDrXTTXssga2DfUQORHB
kKxYD5PW/8rfvThZdN5OKuM6F9zU1o+3K+qf69QnGTptmNiehjpxqHBw76LqQkKC
Whbovk9ZP4DmP6BOj3HoWggrjzP/40SGs+5b/UFhAoGBAJXCBc5UmpvVUJPT/m63
ktYxaqcxn0QiVpnsM/Zug7Gc0PHU4EalsrOEfjXf4b4aHPbXLIvS3/9F2+ej5wwy
jHkmY8jH2C/sOc+wbUincCUcOfHQDn6Dr8iKenKiSSEBLtfcrBdLDvpcz0KbwRTk
Z29mJJ2qyw8fQwtM1g8cNba/
-----END PRIVATE KEY-----
`;

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function frame(opcode, payload, fin = true) {
	const body = Buffer.from(payload);
	const header =
		body.length < 126
			? Buffer.from([(fin ? 0x80 : 0) | opcode, body.length])
			: Buffer.alloc(4);
	if (body.length >= 126) {
		header[0] = (fin ? 0x80 : 0) | opcode;
		header[1] = 126;
		header.writeUInt16BE(body.length, 2);
	}
	return Buffer.concat([header, body]);
}

// Reads masked client frames; returns [frames, rest].
function parseFrames(buffer) {
	const frames = [];
	let at = 0;
	while (buffer.length - at >= 2) {
		const opcode = buffer[at] & 0x0f;
		const masked = (buffer[at + 1] & 0x80) !== 0;
		let length = buffer[at + 1] & 0x7f;
		let offset = at + 2;
		if (length === 126) {
			if (buffer.length - at < 4) break;
			length = buffer.readUInt16BE(at + 2);
			offset = at + 4;
		}
		if (buffer.length - offset < (masked ? 4 : 0) + length) break;
		const mask = buffer.subarray(offset, offset + 4);
		const data = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
		for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
		frames.push({ opcode, masked, data });
		at = offset + 4 + length;
	}
	return [frames, buffer.subarray(at)];
}

function startServer(script, create = (listener) => net.createServer(listener)) {
	const log = [];
	const server = create((socket) => {
		let buffer = Buffer.alloc(0);
		let upgraded = false;
		socket.on("data", (chunk) => {
			buffer = Buffer.concat([buffer, chunk]);
			if (!upgraded) {
				const end = buffer.indexOf("\r\n\r\n");
				if (end < 0) return;
				const lines = buffer.subarray(0, end).toString().split("\r\n");
				buffer = buffer.subarray(end + 4);
				const headers = Object.fromEntries(
					lines.slice(1).map((line) => {
						const colon = line.indexOf(":");
						return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
					}),
				);
				log.push(
					`request ${lines[0]} upgrade=${headers.upgrade} version=${headers["sec-websocket-version"]} protocol=${headers["sec-websocket-protocol"]}`,
				);
				upgraded = true;
				script.onUpgrade(
					socket,
					headers,
					createHash("sha1")
						.update(headers["sec-websocket-key"] + GUID)
						.digest("base64"),
				);
			}
			const [frames, rest] = parseFrames(buffer);
			buffer = rest;
			for (const received of frames) {
				log.push(
					`frame op=${received.opcode} masked=${received.masked} ${received.opcode === 2 ? received.data.toString("hex") : JSON.stringify(received.data.toString())}`,
				);
				script.onFrame(socket, received);
			}
		});
		socket.on("error", () => {});
	});
	return new Promise((resolve) =>
		server.listen(0, "127.0.0.1", () => resolve({ server, log })),
	);
}

function accept(socket, key, extra = "") {
	socket.write(
		`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${key}\r\n${extra}\r\n`,
	);
}

async function session(label, script, open, create) {
	const { server, log } = await startServer(script, create);
	const events = [];
	await new Promise((resolve) => {
		const ws = open(server.address().port);
		events.push(
			`created readyState=${ws.readyState} url=${ws.url.replace(/:\d+\//, ":PORT/")} binaryType=${ws.binaryType}`,
		);
		ws.onopen = () => {
			events.push(
				`open readyState=${ws.readyState} protocol=${JSON.stringify(ws.protocol)}`,
			);
			script.onOpen?.(ws);
		};
		ws.onmessage = async (event) => {
			const data = event.data;
			const shown =
				typeof data === "string"
					? JSON.stringify(data)
					: data instanceof ArrayBuffer
						? `ArrayBuffer ${Buffer.from(data).toString("hex")}`
						: `Blob ${Buffer.from(await data.arrayBuffer()).toString("hex")}`;
			events.push(`message ${event instanceof MessageEvent} ${shown}`);
			script.onMessage?.(ws, event);
		};
		ws.onerror = (event) =>
			events.push(
				`error ${event.type} ${event instanceof ErrorEvent} ${JSON.stringify(event.message)} ${event.error instanceof TypeError} ${Object.hasOwn(event, "message")}`,
			);
		ws.onclose = (event) => {
			events.push(
				`close ${event instanceof CloseEvent} wasClean=${event.wasClean} code=${event.code} reason=${JSON.stringify(event.reason)} readyState=${ws.readyState}`,
			);
			resolve();
		};
	});
	server.close();
	console.log(label, "client", JSON.stringify(events, null, 1));
	console.log(label, "server", JSON.stringify(log, null, 1));
}

await session(
	"echo",
	{
		onUpgrade(socket, headers, key) {
			accept(socket, key, "Sec-WebSocket-Protocol: chat\r\n");
			socket.write(
				Buffer.concat([frame(1, "hel", false), frame(9, "ping!"), frame(0, "lo")]),
			);
			socket.write(frame(2, Buffer.from([1, 2, 3])));
		},
		onFrame(socket, received) {
			if (received.opcode === 1) socket.write(frame(1, `echo:${received.data}`));
			if (received.opcode === 2) socket.write(frame(2, received.data));
			if (received.opcode === 8) {
				socket.write(frame(8, received.data));
				socket.end();
			}
		},
		onOpen(ws) {
			ws.binaryType = "arraybuffer";
			ws.send("hi");
			ws.send(new Uint8Array([9, 8]));
		},
		onMessage(ws, event) {
			if (event.data === "echo:hi") ws.close(1000, "done");
		},
	},
	(port) => new WebSocket(`ws://localhost:${port}/chat?x=1`, ["chat", "superchat"]),
);

await session(
	"server close",
	{
		onUpgrade(socket, headers, key) {
			accept(socket, key);
			socket.write(
				frame(8, Buffer.concat([Buffer.from([0x0f, 0xa0]), Buffer.from("bye")])),
			);
		},
		onFrame(socket, received) {
			if (received.opcode === 8) socket.end();
		},
	},
	(port) => new WebSocket(`ws://127.0.0.1:${port}/chat?x=1`),
);

await session(
	"bad accept",
	{
		onUpgrade(socket) {
			accept(socket, "wrong");
		},
		onFrame() {},
	},
	(port) => new WebSocket(`ws://127.0.0.1:${port}/chat?x=1`),
);

await session(
	"wss",
	{
		onUpgrade(socket, headers, key) {
			accept(socket, key);
			socket.write(frame(1, "secure"));
		},
		onFrame(socket, received) {
			if (received.opcode === 8) {
				socket.write(frame(8, received.data));
				socket.end();
			}
		},
		onMessage(ws) {
			ws.close(3001);
		},
	},
	(port) => new WebSocket(`wss://localhost:${port}/`),
	(listener) => tls.createServer({ cert: CERT, key: KEY }, listener),
);

console.log(
	"event classes",
	Object.hasOwn(new MessageEvent("message"), "data"),
	"data" in MessageEvent.prototype,
	new MessageEvent("message", { data: 1, origin: "o" }).data,
	JSON.stringify(new MessageEvent("message").ports),
	JSON.stringify(
		[new CloseEvent("close", { code: 4001, reason: 5, wasClean: 1 })].map((e) => [
			e.code,
			e.reason,
			e.wasClean,
		]),
	),
	JSON.stringify(
		[new ErrorEvent("e", { message: "m", lineno: "3" })].map((e) => [
			e.message,
			e.filename,
			e.lineno,
			e.colno,
			e.error,
		]),
	),
	ErrorEvent.length,
	new ErrorEvent("x") instanceof Event,
);

for (const [url, protocols] of [
	["ftp://x"],
	["ws://x/#frag"],
	["not a url"],
	["ws://x", ["a", "a"]],
	["ws://x", "a b"],
]) {
	try {
		new WebSocket(url, protocols).onerror = () => {};
		console.log("constructed", url);
	} catch (error) {
		console.log("rejected", url, error.name, error.message);
	}
}
{
	const ws = new WebSocket("ws://127.0.0.1:9/");
	ws.onerror = () => {};
	try {
		ws.send("x");
	} catch (error) {
		console.log("send while connecting", error.name, error.message);
	}
	for (const [code, reason] of [[999], [1000, "x".repeat(124)]]) {
		try {
			ws.close(code, reason);
		} catch (error) {
			console.log("close", code, error.name, error.message);
		}
	}
	console.log(
		"constants",
		WebSocket.CONNECTING,
		WebSocket.OPEN,
		WebSocket.CLOSING,
		WebSocket.CLOSED,
		ws.OPEN,
	);
	await new Promise(
		(resolve) =>
			(ws.onclose = (event) => {
				console.log("refused close", event.code, event.wasClean);
				resolve();
			}),
	);
}

{
	const describe = (event, target) =>
		JSON.stringify([
			event instanceof MessageEvent,
			event.type,
			event.data,
			event.target === target,
			Array.isArray(event.ports) && Object.isFrozen(event.ports),
			Object.hasOwn(event, "data"),
			event.origin,
			event.lastEventId,
			event.source,
		]);
	const { port1, port2 } = new MessageChannel();
	console.log(
		"MessagePort event",
		await new Promise((resolve) => {
			port2.onmessage = (event) => resolve(describe(event, port2));
			port1.postMessage({ a: 1 });
		}),
	);
	port1.close();
	const sender = new BroadcastChannel("ws-fixture");
	const receiver = new BroadcastChannel("ws-fixture");
	console.log(
		"BroadcastChannel event",
		await new Promise((resolve) => {
			receiver.onmessage = (event) => resolve(describe(event, receiver));
			sender.postMessage("hello");
		}),
	);
	sender.close();
	receiver.close();
}

// Sockets the refused and failed sessions leave half-open would keep both runtimes alive.
process.exit(0);
