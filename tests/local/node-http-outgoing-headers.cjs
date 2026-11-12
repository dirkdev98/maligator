const assert = require("node:assert/strict");
const http = require("node:http");

async function main() {
	assert.equal(
		http.ClientRequest.prototype.getHeader,
		http.OutgoingMessage.prototype.getHeader,
	);
	assert.equal(
		http.ServerResponse.prototype.setHeader,
		http.OutgoingMessage.prototype.setHeader,
	);
	const retainedResponses = [];
	const received = [];
	const server = http.createServer({ requireHostHeader: false }, (request, response) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => {
			body += chunk;
		});
		request.on("end", () => {
			received.push({ headers: request.headers, body });
			response.setHeader("X-Retained", ["first", "second"]);
			retainedResponses.push(response);
			response.end("ok");
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = server.address().port;
	const retainedRequests = [];
	try {
		for (const scenario of ["default", "custom", "removed", "disabled"]) {
			await new Promise((resolve, reject) => {
				const request = http.request(
					{
						hostname: "127.0.0.1",
						port,
						method: "POST",
						agent: false,
						setHost: scenario !== "disabled",
						headers: scenario === "custom" ? { Host: "custom.example" } : {},
					},
					(response) => {
						response.resume();
						response.on("end", resolve);
					},
				);
				request.on("error", reject);
				assert.equal(request.headersSent, false);
				assert.equal(
					request.getHeader("HOST"),
					scenario === "disabled"
						? undefined
						: scenario === "custom"
							? "custom.example"
							: `127.0.0.1:${port}`,
				);
				request.setHeader("X-Replace", "old");
				request.setHeader("x-replace", "new");
				const list = ["one", "two"];
				request.setHeader("X-List", list);
				assert.equal(request.getHeaders()["x-list"], list);
				request.setHeader("X-Removed", "unused");
				request.removeHeader("X-REMOVED");
				assert.equal(request.hasHeader("x-removed"), false);
				request.setHeader("Content-Length", 4);
				if (scenario === "removed") request.removeHeader("host");
				retainedRequests.push(request);
				request.end("body");
				assert.equal(request.headersSent, true);
				assert.throws(() => request.setHeader("X-Late", "late"), {
					code: "ERR_HTTP_HEADERS_SENT",
				});
			});
		}
		for (const [index, scenario] of [
			"default",
			"custom",
			"removed",
			"disabled",
		].entries()) {
			assert.equal(received[index].body, "body");
			assert.equal(received[index].headers["x-replace"], "new");
			assert.equal(received[index].headers["x-list"], "one, two");
			assert.equal(received[index].headers["x-removed"], undefined);
			assert.equal(
				received[index].headers.host,
				scenario === "removed" || scenario === "disabled"
					? undefined
					: scenario === "custom"
						? "custom.example"
						: `127.0.0.1:${port}`,
			);
		}
		await new Promise((resolve) => {
			let request;
			const value = {
				toString() {
					if (request) request.destroy();
					return "cancelled";
				},
			};
			request = http.request({
				hostname: "127.0.0.1",
				port,
				headers: { "X-Reentrant": value },
			});
			request.on("error", () => {});
			request.on("close", resolve);
			try {
				request.end();
			} catch (error) {
				assert.equal(request.destroyed, true);
			}
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(received.length, retainedRequests.length);
		if (typeof globalThis.gc === "function") globalThis.gc();
		for (const request of retainedRequests)
			assert.equal(request.getHeader("x-replace"), "new");
		for (const response of retainedResponses)
			assert.deepEqual(response.getHeader("x-retained"), ["first", "second"]);
		const ipv6 = http.request({ hostname: "::1", port: 43210, agent: false });
		ipv6.on("error", () => {});
		assert.equal(ipv6.getHeader("host"), "[::1]:43210");
		ipv6.destroy();
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
	console.log("OUTGOING HEADERS PASS");
}
main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
