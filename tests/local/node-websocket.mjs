// The global WebSocket client against a deterministic RFC 6455 server written on node:net.
import { createHash } from "node:crypto";
import * as net from "node:net";

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

function startServer(script) {
	const log = [];
	const server = net.createServer((socket) => {
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

async function session(label, script, open) {
	const { server, log } = await startServer(script);
	const events = [];
	await new Promise((resolve) => {
		const ws = open(`ws://127.0.0.1:${server.address().port}/chat?x=1`);
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
		ws.onerror = (event) => events.push(`error ${event.type}`);
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
	(url) => new WebSocket(url, ["chat", "superchat"]),
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
	(url) => new WebSocket(url),
);

await session(
	"bad accept",
	{
		onUpgrade(socket) {
			accept(socket, "wrong");
		},
		onFrame() {},
	},
	(url) => new WebSocket(url),
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

// Sockets the refused and failed sessions leave half-open would keep both runtimes alive.
process.exit(0);
