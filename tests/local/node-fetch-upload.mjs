import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import "../../src/node-globals.mjs";

let firstChunk;
const server = createServer((request, response) => {
	const chunks = [];
	request.on("error", () => response.destroy());
	request.on("data", (chunk) => {
		chunks.push(chunk);
		if (request.url === "/incremental") firstChunk?.();
	});
	request.on("end", () => {
		if (request.url === "/cookies") {
			response.setHeader("Set-Cookie", [
				"session=alpha; Expires=Wed, 21 Oct 2037 07:28:00 GMT; HttpOnly",
				"theme=blue; Path=/",
			]);
			response.end("cookies");
			return;
		}
		if (request.url === "/redirect307" || request.url === "/redirect303") {
			response.writeHead(request.url === "/redirect307" ? 307 : 303, {
				location: "/echo",
			});
			response.end();
			return;
		}
		const bytes = Buffer.concat(chunks);
		response.setHeader("content-type", "application/json");
		response.end(
			JSON.stringify({
				body: bytes.toString("utf8"),
				length: bytes.length,
				type: request.headers["content-type"] ?? "",
				method: request.method,
			}),
		);
	});
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const post = async (body, options = {}, route = "/echo") =>
	(await fetch(base + route, { method: "POST", body, ...options })).json();

const cases = {
	async "response-headers"() {
		const response = await fetch(base + "/cookies");
		assert.ok(response.headers instanceof Headers);
		const cookies = [
			"session=alpha; Expires=Wed, 21 Oct 2037 07:28:00 GMT; HttpOnly",
			"theme=blue; Path=/",
		];
		assert.deepEqual(response.headers.getSetCookie(), cookies);
		const copied = new Headers(response.headers);
		copied.delete("set-cookie");
		assert.deepEqual(response.headers.getSetCookie(), cookies);
		assert.deepEqual(copied.getSetCookie(), []);
		assert.equal(await response.text(), "cookies");
	},
	async "body-init"() {
		const parameters = await post(new URLSearchParams({ greeting: "hello world" }));
		assert.equal(parameters.body, "greeting=hello+world");
		assert.equal(parameters.type, "application/x-www-form-urlencoded;charset=UTF-8");
		const blob = await post(new Blob(["binary 🦎"], { type: "application/example" }));
		assert.equal(blob.body, "binary 🦎");
		assert.equal(blob.type, "application/example");
		const data = new FormData();
		data.append("field", "retained value");
		data.append(
			"file",
			new Blob(["file contents"], { type: "text/plain" }),
			"sample.txt",
		);
		const form = await post(data);
		assert.match(form.type, /^multipart\/form-data; boundary=/);
		assert.ok(form.body.includes('name="field"'));
		assert.ok(form.body.includes("retained value"));
		assert.ok(form.body.includes('filename="sample.txt"'));
		assert.ok(form.body.includes("file contents"));
		const bytes = new Uint8Array([0, 65, 66, 67, 0]).subarray(1, 4);
		const binary = await post(bytes, {
			headers: { "content-type": "application/custom" },
		});
		assert.equal(binary.body, "ABC");
		assert.equal(binary.type, "application/custom");
		assert.equal((await post("")).length, 0);
	},
	async "stream-upload"() {
		let producer;
		const arrived = new Promise((resolve) => {
			firstChunk = resolve;
		});
		const pending = post(
			new ReadableStream({
				start(controller) {
					producer = controller;
					controller.enqueue("first");
				},
			}),
			{ duplex: "half" },
			"/incremental",
		);
		await arrived;
		producer.enqueue(new TextEncoder().encode("last"));
		producer.close();
		assert.equal((await pending).body, "firstlast");
		const nodeStream = Readable.from(["node ", "stream"]);
		assert.equal((await post(nodeStream, { duplex: "half" })).body, "node stream");
		const chunk = new Uint8Array(128 * 1024).fill(65);
		const large = new ReadableStream({
			start(controller) {
				for (let i = 0; i < 4; i++) controller.enqueue(chunk);
				controller.close();
			},
		});
		assert.equal((await post(large, { duplex: "half" })).length, chunk.length * 4);
	},
	async "upload-failure"() {
		const invalid = new ReadableStream({
			start(controller) {
				controller.enqueue({ invalid: true });
				controller.close();
			},
		});
		await assert.rejects(post(invalid, { duplex: "half" }));
		const broken = new ReadableStream({
			pull() {
				throw new Error("source failed");
			},
		});
		await assert.rejects(post(broken, { duplex: "half" }));
		const controller = new AbortController();
		let cancelled = false;
		let waitingController;
		const waiting = new ReadableStream({
			start(value) {
				waitingController = value;
			},
			cancel() {
				cancelled = true;
			},
		});
		const reason = new Error("stop upload");
		const pending = post(waiting, { duplex: "half", signal: controller.signal });
		setTimeout(() => controller.abort(reason), 5);
		try {
			await assert.rejects(pending, (error) => error === reason);
		} finally {
			if (!cancelled) waitingController.close();
		}
		assert.equal(cancelled, true);
		await assert.rejects(post(new ReadableStream()), TypeError);
	},
	async redirects() {
		const replayed = await post(
			new URLSearchParams({ value: "retained" }),
			{},
			"/redirect307",
		);
		assert.equal(replayed.body, "value=retained");
		assert.equal(replayed.type, "application/x-www-form-urlencoded;charset=UTF-8");
		const stream = () =>
			new ReadableStream({
				start(controller) {
					controller.enqueue(new Uint8Array([65]));
					controller.close();
				},
			});
		await assert.rejects(post(stream(), { duplex: "half" }, "/redirect307"), TypeError);
		const rewritten = await post(stream(), { duplex: "half" }, "/redirect303");
		assert.equal(rewritten.method, "GET");
		assert.equal(rewritten.body, "");
	},
	async "request-input"() {
		const request = new Request(base + "/echo", {
			method: "POST",
			body: "inherited",
			headers: { "content-type": "text/custom" },
		});
		const response = await fetch(request);
		const result = await response.json();
		assert.equal(result.body, "inherited");
		assert.equal(result.method, "POST");
		assert.equal(result.type, "text/custom");
		assert.equal(request.bodyUsed, true);
		await assert.rejects(fetch(request), TypeError);
	},
};
try {
	const selected = process.env.MAL_TEST_FETCH_BODY_CASE;
	if (selected) await cases[selected]();
	else for (const run of Object.values(cases)) await run();
	console.log("FETCH UPLOAD PASS");
} finally {
	await new Promise((resolve) => server.close(resolve));
}
