import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { createConnection } from "node:net";
import { connect as connectTls } from "node:tls";

const listen = (server) =>
	new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const close = (server) => new Promise((resolve) => server.close(resolve));
async function connect(server, secure = false) {
	const socket = secure
		? connectTls({
				port: server.address().port,
				host: "127.0.0.1",
				rejectUnauthorized: false,
			})
		: createConnection(server.address().port, "127.0.0.1");
	const chunks = [];
	socket.on("data", (chunk) => chunks.push(chunk));
	const closed = new Promise((resolve) =>
		socket.once("close", () => resolve(Buffer.concat(chunks).toString())),
	);
	await new Promise((resolve, reject) => {
		socket.once(secure ? "secureConnect" : "connect", resolve);
		socket.once("error", reject);
	});
	return { socket, closed };
}

const cases = {
	async expiry() {
		const server = createServer();
		let timedOut = false;
		assert.equal(server.timeout, 0);
		assert.equal(
			server.setTimeout(25, (socket) => {
				timedOut = true;
				assert.equal(socket.timeout, 25);
				assert.equal(socket.destroy(), socket);
				assert.equal(socket.destroyed, true);
			}),
			server,
		);
		await listen(server);
		const client = await connect(server);
		await client.closed;
		assert.equal(timedOut, true);
		await close(server);
	},
	async "default-destroy"() {
		const server = createServer();
		server.setTimeout(25);
		await listen(server);
		const client = await connect(server);
		await client.closed;
		await close(server);
	},
	async zero() {
		let timeouts = 0;
		const server = createServer((_request, response) =>
			setTimeout(() => response.end("completed"), 60),
		);
		server.setTimeout(10, () => {
			timeouts++;
		});
		server.setTimeout(0);
		await listen(server);
		const client = await connect(server);
		client.socket.write("GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
		assert.ok((await client.closed).includes("completed"));
		assert.equal(timeouts, 0);
		await close(server);
	},
	async activity() {
		let timeouts = 0;
		const server = createServer((_request, response) => {
			response.write("started");
			let writes = 0;
			const timer = setInterval(() => {
				response.write("activity");
				if (++writes === 6) {
					clearInterval(timer);
					response.end("completed");
				}
			}, 20);
			response.on("close", () => clearInterval(timer));
		});
		server.setTimeout(70, (socket) => {
			timeouts++;
			socket.destroy();
		});
		await listen(server);
		const client = await connect(server);
		client.socket.write("GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
		assert.ok((await client.closed).includes("completed"));
		assert.equal(timeouts, 0);
		await close(server);
	},
	async latched() {
		let timeouts = 0;
		let accepted;
		const request = new Promise((resolve) => {
			accepted = resolve;
		});
		const server = createServer(() => accepted());
		server.setTimeout(30, (socket) => {
			timeouts++;
			assert.equal(socket.timeout, 30);
			socket.destroy();
		});
		await listen(server);
		const client = await connect(server);
		client.socket.write("GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
		await request;
		server.timeout = 0;
		await client.closed;
		assert.equal(timeouts, 1);
		await close(server);
	},
	async persistence() {
		const server = createServer();
		server.timeout = 12.5;
		assert.equal(server.timeout, 12.5);
		await listen(server);
		await close(server);
		assert.equal(server.timeout, 12.5);
		await listen(server);
		assert.equal(server.timeout, 12.5);
		await close(server);
	},
	async "socket-options"() {
		let calls = 0;
		const callback = () => {
			calls++;
		};
		const server = createServer((request, response) => {
			assert.equal(request.socket.setTimeout(10.5, callback), request.socket);
			assert.equal(request.socket.timeout, 10.5);
			request.socket.setTimeout(0, callback);
			setTimeout(() => response.end("completed"), 50);
		});
		await listen(server);
		const client = await connect(server);
		client.socket.write("GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
		assert.ok((await client.closed).includes("completed"));
		assert.equal(calls, 0);
		await close(server);
	},
	async events() {
		const events = [];
		const server = createServer((request, response) => {
			request.on("error", () => {});
			request.on("timeout", (socket) => {
				assert.equal(socket, request.socket);
				events.push("request");
			});
			response.on("timeout", (socket) => {
				assert.equal(socket, request.socket);
				events.push("response");
			});
			request.socket.on("timeout", () => {
				events.push("socket");
				request.socket.destroy();
			});
		});
		server.setTimeout(30, () => events.push("server"));
		await listen(server);
		const client = await connect(server);
		client.socket.write(
			"POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 4\r\nConnection: close\r\n\r\n",
		);
		await client.closed;
		assert.deepEqual(events, ["request", "response", "server", "socket"]);
		await close(server);
	},
	async "keep-alive"() {
		let timeouts = 0;
		const server = createServer((_request, response) => response.end("completed"));
		server.setTimeout(20, (socket) => {
			timeouts++;
			socket.destroy();
		});
		await listen(server);
		const client = await connect(server);
		const received = new Promise((resolve) => client.socket.once("data", resolve));
		client.socket.write("GET / HTTP/1.1\r\nHost: localhost\r\n\r\n");
		await received;
		await new Promise((resolve) => setTimeout(resolve, 60));
		assert.equal(timeouts, 0);
		client.socket.destroy();
		await client.closed;
		await close(server);
	},
	async "socket-idle"() {
		let calls = 0;
		const server = createServer((request, response) => {
			response.once("finish", () =>
				request.socket.setTimeout(30, () => {
					calls++;
					request.socket.destroy();
				}),
			);
			response.end("completed");
		});
		await listen(server);
		const client = await connect(server);
		client.socket.write("GET / HTTP/1.1\r\nHost: localhost\r\n\r\n");
		await client.closed;
		assert.equal(calls, 1);
		await close(server);
	},
	async tls() {
		const server = createSecureServer({
			key: readFileSync(new URL("../fixtures/tls/self-signed-key.pem", import.meta.url)),
			cert: readFileSync(
				new URL("../fixtures/tls/self-signed-cert.pem", import.meta.url),
			),
		});
		let encrypted = false;
		server.on("tlsClientError", () => {});
		server.setTimeout(100, (socket) => {
			encrypted = socket.encrypted;
			socket.destroy();
		});
		await listen(server);
		const client = await connect(server, true);
		client.socket.write("GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
		await client.closed;
		assert.equal(encrypted, true);
		await close(server);
	},
};
const selected = process.env.MAL_TEST_HTTP_TIMEOUT_CASE;
if (selected) await cases[selected]();
else for (const run of Object.values(cases)) await run();
console.log("HTTP INACTIVITY PASS");
