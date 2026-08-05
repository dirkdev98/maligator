const net = require("node:net");
const tls = require("node:tls");
const { AsyncLocalStorage } = require("node:async_hooks");

const storage = new AsyncLocalStorage();
const raw = storage.run("raw", () =>
	net.connect(Number(process.env.TLS_PORT), "127.0.0.1"),
);
raw.host = "localhost";
raw.on("error", (error) => {
	throw error;
});
raw.on("connect", () => {
	if (storage.getStore() !== "raw") {
		throw new Error("raw socket context was not restored");
	}
	const options = {
		socket: raw,
		servername: "localhost",
		rejectUnauthorized: process.env.TLS_INSECURE !== "1",
	};
	if (process.env.TLS_CA) options.ca = process.env.TLS_CA;
	const socket = storage.run("tls", () => tls.connect(options));
	const chunks = [];
	socket.on("secureConnect", () => {
		if (storage.getStore() !== "tls") {
			throw new Error("TLS connect context was not restored");
		}
		if (!socket.encrypted) throw new Error("socket is not marked encrypted");
		socket.end("ping");
	});
	socket.on("data", (chunk) => {
		if (storage.getStore() !== "tls") {
			throw new Error("TLS data context was not restored");
		}
		chunks.push(chunk);
	});
	socket.on("error", (error) => {
		throw error;
	});
	socket.on("close", (hadError) => {
		if (storage.getStore() !== "raw") {
			throw new Error(`raw socket close context was not restored: ${storage.getStore()}`);
		}
		if (hadError) throw new Error("TLS socket closed with an error");
		if (Buffer.concat(chunks).toString("utf8") !== "pong") {
			throw new Error("unexpected TLS response");
		}
		console.log("NODE TLS PASS");
	});
});
