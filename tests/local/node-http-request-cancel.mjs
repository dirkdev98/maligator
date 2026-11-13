import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { Readable, destroy as destroyStream } from "node:stream";
const selection = process.env.MAL_TEST_REQUEST_CANCEL_CASE;
const reason = new Error("fictional body limit");
let errors = 0,
	closes = 0;
let captured;
let onClosed, onHandled;
const closed = new Promise((resolve) => {
	onClosed = resolve;
});
const handled = new Promise((resolve, reject) => {
	onHandled = { resolve, reject };
});
const server = createServer((request, response) => {
	captured = request;
	request.on("error", (error) => {
		assert.equal(error, reason);
		errors++;
	});
	request.on("close", () => {
		closes++;
		onClosed();
	});
	const run = async () => {
		const socket = request.socket;
		if (selection === "web") {
			const reader = Readable.toWeb(request).getReader();
			assert.equal(new TextDecoder().decode((await reader.read()).value), "first");
			await reader.cancel(reason);
		} else {
			await new Promise((resolve) => request.once("data", resolve));
			if (selection === "destroyer") destroyStream(request, reason);
			else request.destroy(reason);
		}
		assert.equal(request.destroyed, true);
		if (selection !== "direct") {
			assert.equal(request.socket, null);
			assert.equal(request.connection, null);
			assert.equal(socket.destroyed, false);
			response.statusCode = 413;
			response.end("limited");
		}
	};
	run().then(onHandled.resolve, onHandled.reject);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
	const result = await new Promise((resolve, reject) => {
		const request = httpRequest(`http://127.0.0.1:${server.address().port}`, {
			method: "POST",
		});
		request.once("response", (response) => {
			if (selection === "direct") {
				reject(new Error("direct destroy preserved the transport"));
				return;
			}
			request.end("tail");
			let text = "";
			response.on("data", (chunk) => {
				text += chunk.toString();
			});
			response.once("end", () => resolve([response.statusCode, text]));
			response.once("error", reject);
		});
		request.once("error", (error) => {
			if (selection === "direct") resolve(error.code);
			else reject(error);
		});
		request.write("first");
	});
	await handled;
	await closed;
	if (selection === "direct") assert.equal(result, "ECONNRESET");
	else assert.deepEqual(result, [413, "limited"]);
	assert.equal(captured.aborted, true);
	assert.equal(errors, 1);
	assert.equal(closes, 1);
} finally {
	await new Promise((resolve) => server.close(resolve));
}
console.log("HTTP REQUEST CANCEL PASS");
