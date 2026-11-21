import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildNativeBinary,
	HOST_MAIN,
	resolveHarnessExecutionInvocation,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-fetch-client-"));

const server = createServer((request, response) => {
	const chunks: Array<Buffer> = [];
	request.on("data", (chunk: Buffer) => chunks.push(chunk));
	request.on("end", () => {
		const body = Buffer.concat(chunks).toString();
		const url = new URL(request.url ?? "/", "http://localhost");
		switch (url.pathname) {
			case "/redirect":
				response.writeHead(302, { location: "/text?from=redirect" }).end();
				return;
			case "/see-other":
				response.writeHead(303, { location: "/echo" }).end();
				return;
			case "/loop":
				response.writeHead(301, { location: "/loop" }).end();
				return;
			case "/gzip":
				response
					.writeHead(200, { "content-encoding": "gzip" })
					.end(gzipSync("compressed ".repeat(1000)));
				return;
			case "/br":
				response
					.writeHead(200, { "content-encoding": "br" })
					.end(brotliCompressSync("brotli body"));
				return;
			case "/slow":
				response.writeHead(200).write("partial");
				setTimeout(() => response.end("-done"), 5000);
				return;
			case "/big":
				response.writeHead(200).end("x".repeat(1_000_000));
				return;
			case "/missing":
				response.writeHead(404, "Not Here").end("nope");
				return;
			case "/echo":
				response.writeHead(200, { "content-type": "application/json" }).end(
					JSON.stringify({
						method: request.method,
						body,
						custom: request.headers["x-custom"],
						type: request.headers["content-type"],
						encoding: request.headers["accept-encoding"],
					}),
				);
				return;
			default:
				response
					.writeHead(200, { "content-type": "text/plain" })
					.end(`text ${url.search}`);
		}
	});
});

const program = (base: string) => `const base = ${JSON.stringify(base)};
const settle = (promise) => promise.then(
	(value) => value,
	(error) => ({ error: error.name, message: error.message, cause: error.cause?.message }),
);
const results = {};
let r = await fetch(base + "/text?a=1");
results.text = { status: r.status, body: await r.text(), type: r.headers.get("content-type"), url: r.url, redirected: r.redirected };
r = await fetch(base + "/echo", { method: "POST", body: "hello", headers: { "x-custom": "c" } });
results.post = await r.json();
r = await fetch(base + "/redirect");
results.redirect = { status: r.status, body: await r.text(), url: r.url, redirected: r.redirected };
r = await fetch(base + "/see-other", { method: "POST", body: "x" });
results.seeOther = (await r.json()).method;
r = await fetch(base + "/redirect", { redirect: "manual" });
results.manual = { status: r.status, location: r.headers.get("location") };
results.redirectError = await settle(fetch(base + "/redirect", { redirect: "error" }));
results.loop = await settle(fetch(base + "/loop"));
results.gzip = (await (await fetch(base + "/gzip")).text()).length;
results.br = await (await fetch(base + "/br")).text();
r = await fetch(base + "/missing");
results.missing = { status: r.status, statusText: r.statusText, ok: r.ok, body: await r.text() };
r = await fetch(base + "/text", { method: "HEAD" });
results.head = { status: r.status, body: r.body };
results.big = (await (await fetch(base + "/big")).arrayBuffer()).byteLength;
const controller = new AbortController();
r = await fetch(base + "/slow", { signal: controller.signal });
const reading = settle(r.text());
controller.abort();
results.abort = (await reading).error;
const upload = new ReadableStream({
	start(c) {
		c.enqueue(new TextEncoder().encode("streamed "));
		c.enqueue(new TextEncoder().encode("upload"));
		c.close();
	},
});
r = await fetch(base + "/echo", { method: "POST", body: upload, duplex: "half" });
results.upload = (await r.json()).body;
results.refused = await settle(fetch("http://127.0.0.1:1/"));
results.scheme = await settle(fetch("ftp://example/"));
r = await fetch("data:text/plain;base64,aGVsbG8=");
results.data = { status: r.status, type: r.headers.get("content-type"), body: await r.text() };
console.log(JSON.stringify(results));
`;

let results: Record<string, unknown>;
// Collecting at every safepoint shows the requests keep their promises, streams and
// signals alive while the socket works.
let stressResults: Record<string, unknown>;

beforeAll(async () => {
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve);
	});
	const { port } = server.address() as AddressInfo;
	const fixture = path.join(outDir, "fetch-client.mjs");
	writeFileSync(fixture, program(`http://127.0.0.1:${port}`));
	const binary = buildNativeBinary({
		fixture,
		name: "fetch-client",
		mainFile: HOST_MAIN,
		outDir,
		config: resolveBuildConfig({
			engine: { eval: false },
		}),
	});
	const invocation = resolveHarnessExecutionInvocation(binary);
	const run = async (env: NodeJS.ProcessEnv) =>
		JSON.parse(
			(
				await promisify(execFile)(invocation.executable, invocation.args, {
					encoding: "utf8",
					env: { ...process.env, ...env },
					timeout: 240_000,
				})
			).stdout,
		) as Record<string, unknown>;
	results = await run({});
	stressResults = await run(STRESS_ENV);
}, 600_000);

afterAll(() => {
	server.close();
});

describe("fetch over the native HTTP client", () => {
	it("reads a response's status, headers, body and URL", () => {
		expect(results.text).toEqual({
			status: 200,
			body: "text ?a=1",
			type: "text/plain",
			url: expect.stringMatching(/\/text\?a=1$/) as unknown,
			redirected: false,
		});
	});

	it("sends the method, body and headers, with default content negotiation", () => {
		expect(results.post).toEqual({
			method: "POST",
			body: "hello",
			custom: "c",
			type: "text/plain;charset=UTF-8",
			encoding: "gzip, deflate, br",
		});
	});

	it("follows redirects and reports the final URL", () => {
		expect(results.redirect).toEqual({
			status: 200,
			body: "text ?from=redirect",
			url: expect.stringMatching(/\/text\?from=redirect$/) as unknown,
			redirected: true,
		});
		expect(results.seeOther).toBe("GET");
	});

	it("returns a manual redirect and rejects an unwanted or endless one", () => {
		expect(results.manual).toEqual({ status: 302, location: "/text?from=redirect" });
		expect(results.redirectError).toEqual({
			error: "TypeError",
			message: "fetch failed",
			cause: "unexpected redirect",
		});
		expect(results.loop).toEqual({
			error: "TypeError",
			message: "fetch failed",
			cause: "redirect count exceeded",
		});
	});

	it("decodes gzip and brotli bodies", () => {
		expect(results.gzip).toBe("compressed ".repeat(1000).length);
		expect(results.br).toBe("brotli body");
	});

	it("resolves error statuses and gives HEAD a null body", () => {
		expect(results.missing).toEqual({
			status: 404,
			statusText: "Not Here",
			ok: false,
			body: "nope",
		});
		expect(results.head).toEqual({ status: 200, body: null });
	});

	it("streams a large body and a request body", () => {
		expect(results.big).toBe(1_000_000);
		expect(results.upload).toBe("streamed upload");
	});

	it("aborts a body in progress with the signal's reason", () => {
		expect(results.abort).toBe("AbortError");
	});

	it("rejects network failures and unknown schemes with a cause", () => {
		expect(results.refused).toMatchObject({
			error: "TypeError",
			message: "fetch failed",
		});
		expect(results.scheme).toEqual({
			error: "TypeError",
			message: "fetch failed",
			cause: "unknown scheme",
		});
	});

	it("answers data: URLs without a request", () => {
		expect(results.data).toEqual({ status: 200, type: "text/plain", body: "hello" });
	});

	it("behaves the same when the collector runs at every safepoint", () => {
		expect(stressResults).toEqual(results);
	});
});
