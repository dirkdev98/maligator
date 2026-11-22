const net = require("node:net");
const tls = require("node:tls");
const { AsyncLocalStorage } = require("node:async_hooks");

const storage = new AsyncLocalStorage();
const mode = process.env.TLS_MODE || "wrapped";
const rejectsHost = mode === "reject-configured-host";

function connect(raw) {
	const options = {
		...(mode === "configured-host" || rejectsHost
			? { host: rejectsHost ? "other.example.invalid" : "localhost" }
			: { servername: "localhost" }),
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
	if (process.env.TLS_CA) {
		const ca = process.env.TLS_CA;
		options.ca =
			process.env.TLS_CA_BUFFER === "1"
				? Buffer.from(`prefix\n${ca}suffix`).subarray(7, 7 + ca.length)
				: ca;
	}
	const socket = storage.run("tls", () => tls.connect(options));
	const chunks = [];
	let secure = false;
	let rejected = false;
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
		if (rejectsHost) {
			rejected = true;
			return;
		}
		throw error;
	});
	socket.on("close", (hadError) => {
		if (rejectsHost) {
			if (!hadError || !rejected || secure || chunks.length !== 0)
				throw new Error("TLS accepted a certificate for a different hostname");
			console.log("NODE TLS HOST REJECTED");
			return;
		}
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

if (mode !== "wrapped" && mode !== "configured-host" && !rejectsHost) connect();
else {
	const raw = storage.run("raw", () =>
		net.connect(Number(process.env.TLS_PORT), "127.0.0.1"),
	);
	raw.host = mode === "configured-host" ? "other.example.invalid" : "localhost";
	const onRawError = (error) => {
		throw error;
	};
	raw.on("error", onRawError);
	raw.on("connect", () => {
		if (storage.getStore() !== "raw")
			throw new Error("raw socket context was not restored");
		raw.off("error", onRawError);
		connect(raw);
	});
}
