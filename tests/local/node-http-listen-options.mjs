import assert from "node:assert/strict";
import { createServer, get } from "node:http";

const listen = (server, ...args) =>
	new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(...args, function () {
			assert.equal(this, server);
			resolve();
		});
	});
const close = (server) => new Promise((resolve) => server.close(resolve));
const read = (server) =>
	new Promise((resolve, reject) => {
		const address = server.address();
		get({ host: address.address, port: address.port, path: "/" }, (response) => {
			let text = "";
			response.on("data", (chunk) => {
				text += chunk.toString();
			});
			response.on("end", () => resolve(text));
			response.on("error", reject);
		}).on("error", reject);
	});

const cases = {
	async options() {
		const server = createServer((_request, response) => response.end("accepted"));
		await listen(server, { port: "0", host: "localhost", backlog: 8 });
		assert.equal(await read(server), "accepted");
		await close(server);
		await listen(server, 0, "127.0.0.1", 8);
		assert.equal(await read(server), "accepted");
		await close(server);
	},
	async defaults() {
		for (const options of [{ port: undefined }, { port: null }]) {
			const server = createServer();
			await listen(server, options);
			assert.equal(options.port, 0);
			assert.ok(server.address().port > 0);
			await close(server);
		}
		const server = createServer();
		const listening = new Promise((resolve) => server.once("listening", resolve));
		assert.equal(server.listen(), server);
		await listening;
		assert.ok(server.address().port > 0);
		await close(server);
	},
	async ipv6() {
		const server = createServer((_request, response) => response.end("IPv6"));
		await listen(server, { port: 0, host: "::1", ipv6Only: true, backlog: 4 });
		assert.equal(server.address().family, "IPv6");
		assert.equal(await read(server), "IPv6");
		await close(server);
	},
	async invalid() {
		for (const port of [NaN, -1, 65536, "", " \uFEFF "]) {
			const server = createServer();
			assert.throws(() => server.listen({ port }), { code: "ERR_SOCKET_BAD_PORT" });
		}
		const server = createServer();
		assert.throws(() => server.listen({ port: false }), {
			code: "ERR_INVALID_ARG_VALUE",
		});
		assert.throws(() => server.listen({ host: "127.0.0.1" }), {
			code: "ERR_INVALID_ARG_VALUE",
		});
	},
};
const selected = process.env.MAL_TEST_HTTP_LISTEN_CASE;
if (selected) await cases[selected]();
else for (const run of Object.values(cases)) await run();
console.log("HTTP LISTEN OPTIONS PASS");
