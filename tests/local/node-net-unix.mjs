import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const socketPath = path.join(os.tmpdir(), `mal-net-unix-${process.pid}.sock`);
fs.rmSync(socketPath, { force: true });
const log = [];
const clientLog = [];
let serverCloses = 0;

const server = net.createServer((socket) => {
	log.push(
		`connection ${socket.remoteAddress} ${socket.remotePort} ${socket.remoteFamily}`,
	);
	socket.on("data", (chunk) => socket.end(`echo:${chunk}`));
	socket.on("close", () => serverCloses++);
});
server.listen(socketPath, () => log.push("listening event"));
console.log(
	"listen",
	server.listening,
	server.address() === socketPath,
	fs.statSync(socketPath).isSocket(),
);

await new Promise((resolve) => server.once("listening", resolve));

await new Promise((resolve) => {
	const second = net.createServer();
	second.on("error", (error) => {
		console.log(
			"in use",
			error.code,
			error.syscall,
			error.address === socketPath,
			error.port,
			typeof error.errno,
			error.message === `listen EADDRINUSE: address already in use ${socketPath}`,
		);
		resolve();
	});
	second.listen({ path: socketPath });
});

await new Promise((resolve) => {
	const client = net.connect(socketPath, () => {
		clientLog.push(`client connect ${client.remoteAddress} ${client.remotePort}`);
		client.write("hello");
	});
	client.on("data", (chunk) => clientLog.push(`client data ${chunk}`));
	client.on("close", () => {
		clientLog.push("client close");
		resolve();
	});
});

await new Promise((resolve) => {
	const client = net.createConnection({ path: socketPath }, () => {
		clientLog.push("options connect");
		client.end("again");
	});
	client.on("data", (chunk) => clientLog.push(`options data ${chunk}`));
	client.on("close", resolve);
});

await new Promise((resolve) => server.close(resolve));
console.log("closed, path exists", fs.existsSync(socketPath), serverCloses);

await new Promise((resolve) => {
	const missing = net.createConnection({ path: socketPath });
	missing.on("error", (error) => {
		console.log(
			"missing",
			error.code,
			error.syscall,
			error.address === socketPath,
			error.message === `connect ENOENT ${socketPath}`,
		);
	});
	missing.on("close", (hadError) => {
		console.log("missing close", hadError);
		resolve();
	});
});

console.log(log.join("\n"));
console.log(clientLog.join("\n"));
