import assert from "node:assert/strict";
import { createServer, request } from "node:http";

const server = createServer((incoming, response) => {
	const [status, explicit] = incoming.url.slice(1).split("/");
	response.statusCode = Number(status);
	if (explicit === "length") response.setHeader("content-length", "100");
	response.end("ignored body");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
	for (const [method, status] of [
		["HEAD", 200],
		["GET", 204],
		["GET", 304],
	]) {
		for (const explicit of [false, true]) {
			await new Promise((resolve, reject) => {
				request(
					`http://127.0.0.1:${server.address().port}/${status}/${explicit ? "length" : "none"}`,
					{ method },
					(response) => {
						assert.equal(response.statusCode, status);
						assert.equal(
							response.headers["content-length"],
							explicit ? "100" : undefined,
						);
						let bytes = 0;
						response.on("data", (chunk) => {
							bytes += chunk.length;
						});
						response.once("error", reject);
						response.once("end", () => {
							assert.equal(bytes, 0);
							resolve();
						});
					},
				)
					.once("error", reject)
					.end();
			});
		}
	}
} finally {
	await new Promise((resolve) => server.close(resolve));
}
console.log("HTTP BODYLESS LENGTH PASS");
