import assert from "node:assert/strict";
import { createServer, request } from "node:http";

const fetchJson = (input, options) =>
	new Promise((resolve, reject) => {
		const outgoing = request(input, options, (response) => {
			let body = "";
			response.on("data", (chunk) => {
				body += chunk.toString();
			});
			response.on("end", () => resolve(JSON.parse(body)));
			response.on("error", reject);
		});
		outgoing.on("error", reject);
		outgoing.end();
	});
async function withServer(host, run) {
	const server = createServer((incoming, response) =>
		response.end(JSON.stringify({ path: incoming.url, host: incoming.headers.host })),
	);
	await new Promise((resolve) => server.listen({ port: 0, host }, resolve));
	try {
		await run(server.address().port);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
}
function inspect(input) {
	const outgoing = request(input);
	outgoing.on("error", () => {});
	try {
		return { path: outgoing.path, host: outgoing.getHeader("Host") };
	} finally {
		outgoing.destroy();
	}
}

const cases = {
	async ipv6() {
		await withServer("::1", async (port) => {
			const result = await fetchJson(`http://[::1]:${port}/route?value=yes#ignored`);
			assert.deepEqual(result, { path: "/route?value=yes", host: `[::1]:${port}` });
		});
	},
	async canonical() {
		const input = "http://BÜCHER.example/snow man/🦎?value=hello world#ignored";
		const expected = {
			path: "/snow%20man/%F0%9F%A6%8E?value=hello%20world",
			host: "xn--bcher-kva.example",
		};
		assert.deepEqual(inspect(input), expected);
		assert.deepEqual(inspect(new URL(input)), expected);
		assert.deepEqual(inspect("http://exa\tmple.example/line\npath"), {
			path: "/linepath",
			host: "example.example",
		});
	},
	async overrides() {
		await withServer("127.0.0.1", async (port) => {
			const result = await fetchJson("http://unused.example/original#ignored", {
				hostname: "127.0.0.1",
				port,
				path: "/overridden?value=yes",
			});
			assert.deepEqual(result, {
				path: "/overridden?value=yes",
				host: `127.0.0.1:${port}`,
			});
			const query = await fetchJson(`http://127.0.0.1:${port}?value=yes#ignored`);
			assert.equal(query.path, "/?value=yes");
		});
	},
	async invalid() {
		for (const url of [
			"http://[bad]/",
			"http://localhost:65536/",
			"http://bad host/",
			"relative/path",
		]) {
			assert.throws(() => request(url), { code: "ERR_INVALID_URL" });
		}
	},
};
const selected = process.env.MAL_TEST_HTTP_URL_CASE;
if (selected) await cases[selected]();
else for (const run of Object.values(cases)) await run();
console.log("HTTP CLIENT URL PASS");
