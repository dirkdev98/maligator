const net = require("node:net");
const tls = require("node:tls");

const raw = net.connect(Number(process.env.TLS_PORT), "127.0.0.1");
raw.host = "localhost";
raw.on("error", (error) => {
	throw error;
});
raw.on("connect", () => {
	const options = {
		socket: raw,
		servername: "localhost",
		rejectUnauthorized: process.env.TLS_INSECURE !== "1",
	};
	if (process.env.TLS_CA) options.ca = process.env.TLS_CA;
	const socket = tls.connect(options);
	const chunks = [];
	socket.on("secureConnect", () => {
		if (!socket.encrypted) throw new Error("socket is not marked encrypted");
		socket.end("ping");
	});
	socket.on("data", (chunk) => chunks.push(chunk));
	socket.on("error", (error) => {
		throw error;
	});
	socket.on("close", (hadError) => {
		if (hadError) throw new Error("TLS socket closed with an error");
		if (Buffer.concat(chunks).toString("utf8") !== "pong") {
			throw new Error("unexpected TLS response");
		}
		console.log("NODE TLS PASS");
	});
});
