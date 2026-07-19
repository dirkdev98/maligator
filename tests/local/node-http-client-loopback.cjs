const http = require("node:http");

function fail(message) {
	throw new Error(message);
}

const server = http.createServer((request, response) => {
	const chunks = [];
	request.on("data", (chunk) => chunks.push(chunk));
	request.on("end", () => {
		const body = Buffer.concat(chunks).toString("utf8");
		if (request.method !== "POST") fail("method");
		if (request.url !== "/echo?value=1") fail("path");
		if (request.headers["x-loopback"] !== "yes") fail("request header");
		if (body !== "abcdef") fail("request body");
		response.statusCode = 202;
		response.setHeader("Content-Type", "text/plain");
		response.setHeader("Set-Cookie", "loopback=yes; HttpOnly");
		response.end("received:" + body);
	});
});

server.listen(0, "127.0.0.1", () => {
	const port = server.address().port;
	const request = http.request(
		`http://localhost:${port}/echo?value=1`,
		{ method: "post", headers: { "X-Loopback": "yes" } },
		(response) => {
			const chunks = [];
			if (response.statusCode !== 202) fail("status");
			if (response.headers["content-type"] !== "text/plain") fail("response header");
			if (response.headers["set-cookie"][0] !== "loopback=yes; HttpOnly") {
				fail("set-cookie");
			}
			response.on("data", (chunk) => chunks.push(chunk));
			response.on("end", () => {
				if (Buffer.concat(chunks).toString("utf8") !== "received:abcdef") {
					fail("response body");
				}
				server.close(() => {
					const refused = http.request(`http://127.0.0.1:${port}/closed`);
					refused.on("error", (error) => {
						if (!(error instanceof Error)) fail("error object");
						console.log("HTTP CLIENT LOOPBACK PASS");
					});
					refused.end();
				});
			});
		},
	);
	request.on("error", (error) => fail("unexpected error: " + error.message));
	request.write("abc");
	request.end("def");
});
