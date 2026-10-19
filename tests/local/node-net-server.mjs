import dns from "node:dns";
import net, { Server, createServer } from "node:net";

// Server and client events come from separate sockets, so each side keeps its own order.
const log = [];
const clientLog = [];
const server = createServer((socket) => {
	log.push(
		`connection ${socket.server === server} ${socket.remoteAddress} ${typeof socket.remotePort}`,
	);
	socket.on("data", (chunk) => {
		log.push(`server data ${chunk}`);
		socket.write(`echo:${chunk}`);
	});
	socket.on("end", () => log.push("server end"));
	socket.on("close", () => log.push("server socket close"));
});
console.log(
	"server",
	server instanceof Server,
	server instanceof net.Server,
	server.listening,
	server.address(),
);
server.on("listening", () => log.push("listening event"));
server.on("close", () => log.push("server close"));

await new Promise((resolve) => {
	server.listen(0, "127.0.0.1", () => {
		const address = server.address();
		console.log(
			"listening",
			server.listening,
			address.address,
			address.family,
			typeof address.port,
			address.port > 0,
		);
		resolve();
	});
	console.log("listen returns", server.listening);
});

const { port } = server.address();
await new Promise((resolve) => {
	const client = net.connect(port, "127.0.0.1", () => {
		clientLog.push("client connect");
		client.write("hello");
	});
	client.on("data", (chunk) => {
		clientLog.push(`client data ${chunk}`);
		server.getConnections((error, count) => {
			clientLog.push(`connections ${error} ${count}`);
			client.end();
		});
	});
	client.on("close", () => {
		clientLog.push("client close");
		resolve();
	});
});

await new Promise((resolve) => {
	const second = new Server({ pauseOnConnect: true });
	second.on("error", (error) => {
		console.log(
			"in use",
			error.name,
			error.code,
			error.syscall,
			error.address,
			error.port === port,
			error.message === `listen EADDRINUSE: address already in use 127.0.0.1:${port}`,
		);
		resolve();
	});
	second.listen({ port, host: "127.0.0.1" });
});

await new Promise((resolve) => {
	server.close(() => {
		log.push("close callback");
		resolve();
	});
	log.push(`after close ${server.listening} ${server.address()}`);
});

await new Promise((resolve) => {
	createServer().close((error) => {
		console.log("not running", error.code, error.message);
		resolve();
	});
});

await new Promise((resolve) => {
	const limited = createServer(() => console.log("unexpected connection"));
	limited.maxConnections = 0;
	limited.on("drop", (data) => {
		console.log(
			"drop",
			Object.keys(data).join(),
			data.localAddress,
			typeof data.remotePort,
		);
		limited.close(resolve);
	});
	limited.listen(0, "127.0.0.1", () => {
		const client = net.connect(limited.address().port, "127.0.0.1");
		client.on("error", () => {});
	});
});

const disposable = createServer();
await new Promise((resolve) => disposable.listen(0, "127.0.0.1", resolve));
await disposable[Symbol.asyncDispose]();
console.log("disposed", disposable.listening);

await new Promise((resolve) => {
	const lookupLog = [];
	const named = createServer((socket) => socket.end("named"));
	// "127.1" is not an IP literal for net.isIP, so it resolves through dns.lookup without the network.
	named.listen(0, "127.1", () => {
		const namedPort = named.address().port;
		console.log("named listen", named.address().address, named.listening);
		const client = net.connect({
			port: namedPort,
			host: "service.test",
			lookup(host, options, callback) {
				lookupLog.push(
					`lookup ${host} ${options.family} ${options.hints === dns.ADDRCONFIG} ${options.all}`,
				);
				setImmediate(() => callback(null, [{ address: "127.0.0.1", family: 4 }]));
			},
		});
		client.on("lookup", (error, address, family, host) =>
			lookupLog.push(`lookup event ${error} ${address} ${family} ${host}`),
		);
		client.on("connect", () => lookupLog.push(`connect ${client.remoteAddress}`));
		client.on("data", (chunk) => lookupLog.push(`data ${chunk}`));
		client.on("close", () => {
			const failing = net.connect({
				port: namedPort,
				host: "missing.test",
				lookup(host, options, callback) {
					const error = new Error(`getaddrinfo ENOTFOUND ${host}`);
					error.code = "ENOTFOUND";
					setImmediate(() => callback(error));
				},
			});
			failing.on("lookup", (error, address, family, host) =>
				lookupLog.push(`failed lookup ${error.code} ${address} ${family} ${host}`),
			);
			failing.on("error", (error) =>
				lookupLog.push(`error ${error.code} ${error.message}`),
			);
			failing.on("close", (hadError) => {
				lookupLog.push(`failed close ${hadError}`);
				const resolved = net.connect(namedPort, "127.1");
				resolved.on("lookup", (error, address, family, host) =>
					lookupLog.push(`dns lookup ${error} ${address} ${family} ${host}`),
				);
				resolved.on("connect", () =>
					lookupLog.push(`dns connect ${resolved.remoteAddress}`),
				);
				resolved.resume();
				resolved.on("close", () => {
					console.log(lookupLog.join("\n"));
					named.close(resolve);
				});
			});
		});
	});
});

try {
	createServer().listen(70000);
} catch (error) {
	console.log("bad port", error.name, error.code, error.message);
}
console.log(log.join("\n"));
console.log(clientLog.join("\n"));

const background = createServer();
background.unref();
background.listen(0, "127.0.0.1", () => {
	console.log("unref listening", background._unref);
});
