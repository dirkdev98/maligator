import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createConnection } from "node:net";
for (const [requestSize, responseSize, delayed] of [
	[128, 2, false],
	[4096, 2, false],
	[8192, 2, false],
	[4096, 512 * 1024, false],
	[128, 2, true],
	[4096, 2, true],
]) {
	const body = "x".repeat(responseSize);
	let responseClosed = false;
	let checkDelayed;
	const delayedChecked = new Promise((resolve) => {
		checkDelayed = resolve;
	});
	const server = createServer((request, response) => {
		response.on("close", () => {
			responseClosed = true;
		});
		if (delayed)
			setTimeout(() => {
				assert.equal(responseClosed, true);
				assert.equal(response.destroyed, true);
				checkDelayed();
			}, 30);
		else response.end(body);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const received = await new Promise((resolve, reject) => {
			const socket = createConnection(server.address().port, "127.0.0.1");
			let text = "";
			socket.on("data", (chunk) => {
				text += chunk.toString();
			});
			socket.once("error", reject);
			socket.once("close", () => resolve(text));
			const prefix = "GET / HTTP/1.1\r\nHost: example.test\r\nX-Padding: ";
			const suffix = "\r\nConnection: close\r\n\r\n";
			const wire =
				prefix + "a".repeat(requestSize - prefix.length - suffix.length) + suffix;
			assert.equal(wire.length, requestSize);
			socket.end(wire);
		});
		if (delayed) {
			assert.equal(received, "");
			await delayedChecked;
		} else {
			const bodyStart = received.indexOf("\r\n\r\n");
			assert.ok(bodyStart >= 0);
			assert.equal(received.slice(bodyStart + 4), body);
		}
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
}
console.log("HTTP HALF CLOSE PASS");
