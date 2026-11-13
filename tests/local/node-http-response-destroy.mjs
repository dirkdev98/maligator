import assert from "node:assert/strict";
import { createServer, get, request as makeRequest, OutgoingMessage } from "node:http";
const error = new Error("fictional source failure");
const detached = new OutgoingMessage();
let detachedCloses = 0;
detached.on("close", () => detachedCloses++);
assert.equal(detached.errored, null);
assert.equal(detached.destroy(error), detached);
assert.equal(detached.destroyed, true);
assert.equal(detached.errored, error);
assert.equal(detached.destroy(new Error("ignored")), detached);
assert.equal(detached.errored, error);
await new Promise((resolve) => setImmediate(resolve));
assert.equal(detachedCloses, 1);
let responseCloses = 0;
let socketCloses = 0;
let socketErrors = 0;
let socketDestroys = 0;
let destroyedResponse;
const server = createServer((request, response) => {
	if (request.url === "/ok") {
		response.end("still usable");
		return;
	}
	destroyedResponse = response;
	const destroy = response.socket.destroy;
	response.socket.destroy = function (reason) {
		socketDestroys++;
		assert.equal(reason, error);
		return destroy.call(this, reason);
	};
	response.socket.on("error", (reason) => {
		assert.equal(reason, error);
		socketErrors++;
	});
	response.socket.on("close", (hadError) => {
		assert.equal(hadError, true);
		socketCloses++;
	});
	response.on("close", () => responseCloses++);
	response.write("prefix");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}`;
try {
	await new Promise((resolve, reject) => {
		const request = get(url, (response) => {
			response.once("data", (chunk) => {
				assert.equal(chunk.toString(), "prefix");
				assert.equal(destroyedResponse.destroy(error), destroyedResponse);
				assert.equal(destroyedResponse.destroyed, true);
				assert.equal(destroyedResponse.errored, error);
				destroyedResponse.destroy(error);
			});
			response.once("aborted", resolve);
			response.on("error", () => {});
			response.once("end", () => reject(new Error("destroyed response ended normally")));
		});
		request.once("error", reject);
	});
	const text = await new Promise((resolve, reject) => {
		get(url + "/ok", (response) => {
			let body = "";
			response.setEncoding("utf8");
			response.on("data", (chunk) => {
				body += chunk;
			});
			response.once("end", () => resolve(body));
		}).once("error", reject);
	});
	assert.equal(text, "still usable");
	assert.equal(responseCloses, 1);
	assert.ok(socketDestroys >= 1);
	assert.equal(socketErrors, 1);
	assert.equal(socketCloses, 1);
} finally {
	await new Promise((resolve) => server.close(resolve));
}
console.log("HTTP RESPONSE DESTROY PASS");
