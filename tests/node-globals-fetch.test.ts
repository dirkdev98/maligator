import { createServer } from "node:http";
import type { Server } from "node:http";
import { afterAll, beforeAll, expect, test } from "vitest";
import { maligatorFetch } from "../src/node-globals.mjs";

const fetch = maligatorFetch as typeof globalThis.fetch;
let server: Server;
let base: string;

beforeAll(async () => {
	server = createServer((request, response) => {
		if (request.url === "/redirect") {
			response.writeHead(302, { location: "/stream" });
			response.end();
		} else if (request.url === "/empty") {
			response.writeHead(204);
			response.end();
		} else {
			response.writeHead(200);
			response.write("first");
			const timer = setTimeout(() => response.end("last"), 40);
			response.on("close", () => clearTimeout(timer));
		}
	});
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (address === null || typeof address === "string")
		throw new Error("Missing server port");
	base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
	await new Promise<void>((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
	});
});

test("exposes body chunks before EOF and follows redirects", async () => {
	const response = await fetch(`${base}/redirect`);
	expect(response.redirected).toBe(true);
	expect(response.url).toBe(`${base}/stream`);
	const reader = response.body!.getReader();
	const first = await reader.read();
	expect(response.bodyUsed).toBe(true);
	expect(Buffer.from(first.value!).toString()).toBe("first");
	const last = await reader.read();
	expect(Buffer.from(last.value!).toString()).toBe("last");
	expect((await reader.read()).done).toBe(true);
	reader.releaseLock();
	await expect(response.text()).rejects.toThrow();
});

test("preserves abort reasons while reading and permits cancellation", async () => {
	const controller = new AbortController();
	const response = await fetch(`${base}/stream`, { signal: controller.signal });
	const reader = response.body!.getReader();
	await reader.read();
	const reason = new Error("stop download");
	controller.abort(reason);
	await expect(reader.read()).rejects.toBe(reason);
	const cancelled = await fetch(`${base}/stream`);
	await cancelled.body!.cancel();
});

test("honors redirect modes, null bodies, timeout and one-time consumption", async () => {
	await expect(fetch(`${base}/redirect`, { redirect: "error" })).rejects.toThrow(
		"Unexpected redirect",
	);
	const manual = await fetch(`${base}/redirect`, { redirect: "manual" });
	expect(manual.status).toBe(302);
	await manual.body!.cancel();
	expect((await fetch(`${base}/empty`)).body).toBeNull();
	await expect(
		fetch(`${base}/stream`, { signal: AbortSignal.timeout(10) }).then((response) =>
			response.text(),
		),
	).rejects.toMatchObject({ name: "TimeoutError" });
	const data = await fetch("data:,hello");
	expect(await data.text()).toBe("hello");
	await expect(data.text()).rejects.toThrow(TypeError);
});

test.each([
	["data:,hello%20world", "hello world", "text/plain;charset=US-ASCII"],
	["data:;base64,aGVsbG8=", "hello", "text/plain;charset=US-ASCII"],
	["data:text/plain;base64,aGVsbG8=", "hello", "text/plain"],
	["data:text/plain;charset=utf-8;base64,aGVsbG8=", "hello", "text/plain;charset=utf-8"],
	["data:text/plain,hello%20world", "hello world", "text/plain"],
	[
		"data:text/plain;base64;mode=plain,aGVsbG8=",
		"aGVsbG8=",
		"text/plain;base64;mode=plain",
	],
])("preserves data URL bytes and media type for %s", async (url, body, contentType) => {
	const response = await fetch(url);
	expect(response.headers.get("content-type")).toBe(contentType);
	expect(await response.text()).toBe(body);
});
