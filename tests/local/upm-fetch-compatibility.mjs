import http from "node:http";
import { maligatorFetch as fetch } from "../../src/node-globals.mjs";

for (const id of [
	"assert",
	"assert/strict",
	"async_hooks",
	"buffer",
	"child_process",
	"cluster",
	"crypto",
	"diagnostics_channel",
	"dns",
	"domain",
	"events",
	"fs",
	"fs/promises",
	"http",
	"http2",
	"https",
	"inspector",
	"module",
	"net",
	"os",
	"path",
	"perf_hooks",
	"process",
	"querystring",
	"readline",
	"sqlite",
	"stream",
	"stream/promises",
	"string_decoder",
	"timers/promises",
	"tls",
	"tty",
	"url",
	"util",
	"v8",
	"vm",
	"worker_threads",
	"zlib",
]) {
	const module = globalThis.process.getBuiltinModule(id);
	if (!module || module !== globalThis.process.getBuiltinModule("node:" + id))
		throw new Error("Builtin alias identity: " + id);
}
if (globalThis.process.getBuiltinModule("http") !== http)
	throw new Error("Static builtin identity");

let held;
let stage = "listen";
const server = http.createServer((request, response) => {
	if (request.url === "/redirect") {
		response.statusCode = 302;
		response.setHeader("location", "/stream");
		response.end();
	} else if (request.url === "/empty") {
		response.statusCode = 204;
		response.end();
	} else {
		response.statusCode = 200;
		response.write("first");
		held = response;
	}
});

function check(condition, message) {
	if (!condition) throw new Error(message);
}

server.listen(0, "127.0.0.1", async () => {
	try {
		const base = "http://127.0.0.1:" + server.address().port;
		stage = "fetch redirect";
		const response = await fetch(base + "/redirect", {
			signal: AbortSignal.timeout(10000),
		});
		check(
			response.redirected && response.url === base + "/stream",
			"redirect " +
				JSON.stringify([
					response.redirected,
					response.url,
					response.status,
					base,
					response.headers.get("location"),
				]),
		);
		stage = "first reader";
		const reader = response.body.getReader();
		check(
			Buffer.from((await reader.read()).value).toString() === "first",
			"stream before EOF",
		);
		stage = "bodyUsed";
		check(response.bodyUsed, "disturbed body");
		held.end("last");
		check(
			Buffer.from((await reader.read()).value).toString() === "last",
			"stream final chunk",
		);
		check((await reader.read()).done, "stream EOF");
		reader.releaseLock();
		let consumed = false;
		try {
			await response.text();
		} catch (error) {
			consumed = error instanceof TypeError;
		}
		check(consumed, "second body consumption");
		check((await fetch(base + "/empty")).body === null, "empty response");
		stage = "abort request";
		const controller = new AbortController();
		const interrupted = await fetch(base + "/stream", { signal: controller.signal });
		const interruptedReader = interrupted.body.getReader();
		await interruptedReader.read();
		const reason = new Error("abort body");
		controller.abort(reason);
		let aborted = false;
		try {
			await interruptedReader.read();
		} catch (error) {
			aborted = error === reason;
		}
		check(aborted, "abort reason while reading");
		interruptedReader.releaseLock();
		stage = "cancel request";
		const cancelled = await fetch(base + "/stream");
		await cancelled.body.cancel();
		check((await (await fetch("data:,hello")).text()) === "hello", "data fetch");
		console.log("UPM FETCH PASS");
	} catch (error) {
		console.error(stage, error?.name, error?.message, error?.stack);
		globalThis.process.exitCode = 1;
	} finally {
		server.closeAllConnections();
		server.close();
	}
});
