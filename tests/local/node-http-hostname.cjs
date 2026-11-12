const assert = require("node:assert/strict");
const http = require("node:http");
const https = require("node:https");
const tls = require("node:tls");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { AsyncLocalStorage } = require("node:async_hooks");

const context = new AsyncLocalStorage();

function listen(server, host) {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, host, () => {
			server.removeListener("error", reject);
			assert.equal(context.getStore(), "listen-context");
			resolve(server.address());
		});
	});
}

function close(server) {
	return new Promise((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve())),
	);
}

function exchange(protocol, address) {
	if (protocol === https) {
		return new Promise((resolve, reject) => {
			let response = "";
			const socket = tls.connect(
				{
					host: address.address,
					port: address.port,
					rejectUnauthorized: false,
				},
				() =>
					socket.write("GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"),
			);
			socket.setEncoding("utf8");
			socket.on("data", (chunk) => {
				response += chunk;
			});
			socket.on("error", reject);
			socket.on("end", () => resolve(response.split("\r\n\r\n")[1]));
		});
	}
	return new Promise((resolve, reject) => {
		const request = protocol.get(
			{
				hostname: address.address,
				port: address.port,
			},
			(response) => {
				let body = "";
				response.setEncoding("utf8");
				response.on("data", (chunk) => {
					body += chunk;
				});
				response.on("end", () => resolve(body));
			},
		);
		request.on("error", reject);
	});
}

async function main() {
	for (const protocol of [http, https]) {
		const server =
			protocol === https
				? https.createServer(
						{
							key: readFileSync(
								join(__dirname, "../fixtures/tls/localhost-server-key.pem"),
							),
							cert: readFileSync(
								join(__dirname, "../fixtures/tls/localhost-server-cert.pem"),
							),
						},
						(_request, response) => response.end("hostname response"),
					)
				: http.createServer((_request, response) => response.end("hostname response"));
		try {
			const ready = context.run("listen-context", () => listen(server, "localhost"));
			assert.equal(server.address(), null);
			const address = await ready;
			assert.ok(["IPv4", "IPv6"].includes(address.family));
			assert.ok(address.port > 0);
			assert.equal(await exchange(protocol, address), "hostname response");
		} finally {
			await close(server);
		}
	}

	const cancelled = http.createServer();
	cancelled.on("error", (error) => {
		throw error;
	});
	const oldListener = () => {
		throw new Error("cancelled lookup started listening");
	};
	cancelled.listen(0, "maligator-test.invalid", oldListener);
	await new Promise((resolve) =>
		cancelled.close((error) => {
			assert.equal(error.code, "ERR_SERVER_NOT_RUNNING");
			resolve();
		}),
	);
	cancelled.removeListener("listening", oldListener);
	await context.run("listen-context", () => listen(cancelled, "localhost"));
	await close(cancelled);

	const failed = http.createServer();
	let synchronous = true;
	await new Promise((resolve) => {
		failed.once("error", (error) => {
			assert.equal(synchronous, false);
			assert.equal(error.code, "ENOTFOUND");
			assert.equal(error.syscall, "getaddrinfo");
			assert.equal(failed.address(), null);
			resolve();
		});
		failed.listen(0, "maligator-test.invalid");
		synchronous = false;
	});
	console.log("HTTP HOSTNAME PASS");
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
