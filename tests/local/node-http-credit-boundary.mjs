import assert from "node:assert/strict";
import { createServer, request } from "node:http";
const payload = "x".repeat(16 * 1024);
let delivered = 0;
const server = createServer((incoming, response) => {
	const read = incoming._read;
	let granted = false;
	incoming._read = function (size) {
		if (!granted) {
			granted = true;
			read.call(this, size);
		}
	};
	incoming.on("data", (chunk) => {
		delivered += chunk.length;
	});
	incoming.once("end", () => {
		assert.equal(incoming.complete, true);
		assert.equal(delivered, Buffer.byteLength(payload));
		response.end("complete");
	});
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
	const body = await new Promise((resolve, reject) => {
		const outgoing = request(
			`http://127.0.0.1:${server.address().port}`,
			{ method: "POST" },
			(response) => {
				let text = "";
				response.on("data", (chunk) => {
					text += chunk.toString();
				});
				response.once("end", () => resolve(text));
				response.once("error", reject);
			},
		);
		outgoing.once("error", reject);
		outgoing.end(payload);
	});
	assert.equal(body, "complete");
} finally {
	await new Promise((resolve) => server.close(resolve));
}
console.log("HTTP CREDIT BOUNDARY PASS");
