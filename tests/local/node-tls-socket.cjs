const net = require("node:net");
const tls = require("node:tls");
const { AsyncLocalStorage } = require("node:async_hooks");

const storage = new AsyncLocalStorage();
const mode = process.env.TLS_MODE || "wrapped";

function connect(raw) {
	const options = {
		servername: "localhost",
		rejectUnauthorized: process.env.TLS_INSECURE !== "1",
	};
	if (raw) options.socket = raw;
	else {
		options.port = Number(process.env.TLS_PORT);
		options.host = "localhost";
		if (mode === "retry")
			options.lookup = (_host, _options, callback) => {
				callback(null, [
					{ address: "::1", family: 6 },
					{ address: "127.0.0.1", family: 4 },
				]);
			};
		if (mode === "cancel")
			options.lookup = (_host, _options, callback) => {
				setTimeout(() => callback(null, [{ address: "127.0.0.1", family: 4 }]), 20);
			};
	}
	if (process.env.TLS_CA) options.ca = process.env.TLS_CA;
	const socket = storage.run("tls", () => tls.connect(options));
	const chunks = [];
	let secure = false;
	socket.on("secureConnect", () => {
		if (storage.getStore() !== "tls") {
			throw new Error("TLS connect context was not restored");
		}
		secure = true;
		if (!socket.encrypted) throw new Error("socket is not marked encrypted");
		if (mode !== "queued" && mode !== "early-end") socket.end("ping");
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
		if (storage.getStore() !== (raw ? "raw" : "tls")) {
			throw new Error(`socket close context was not restored: ${storage.getStore()}`);
		}
		if (hadError) throw new Error("TLS socket closed with an error");
		if (mode === "cancel" ? secure : !secure)
			throw new Error("unexpected TLS handshake state");
		if (
			Buffer.concat(chunks).toString("utf8") !==
			(mode === "early-end" || mode === "cancel" ? "" : "pong")
		) {
			throw new Error("unexpected TLS response");
		}
		console.log("NODE TLS PASS");
	});
	if (mode === "queued") socket.end("ping");
	if (mode === "early-end") socket.end();
	if (mode === "cancel") socket.destroy();
}

if (mode !== "wrapped") connect();
else {
	const raw = storage.run("raw", () =>
		net.connect(Number(process.env.TLS_PORT), "127.0.0.1"),
	);
	raw.host = "localhost";
	raw.on("error", (error) => {
		throw error;
	});
	raw.on("connect", () => {
		if (storage.getStore() !== "raw")
			throw new Error("raw socket context was not restored");
		connect(raw);
	});
}
