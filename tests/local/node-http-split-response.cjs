"use strict";
const http = require("node:http");

// The first chunk is acknowledged while the request's end is still queued, and the
// response only ends on a later turn, so its final write waits on that acknowledgement.
const server = http.createServer((request, response) => {
	response.statusCode = 200;
	response.setHeader("content-length", "2");
	response.write("a");
	setTimeout(() => response.end("b"), 0);
});

function get(origin) {
	return new Promise((resolve, reject) => {
		http
			.get(origin, (response) => {
				let body = "";
				response.on("data", (chunk) => (body += chunk));
				response.on("end", () => resolve(body));
			})
			.on("error", reject);
	});
}

const watchdog = setTimeout(() => {
	console.log("HTTP SPLIT RESPONSE HUNG");
	process.exit(1);
}, 20_000);

server.listen(0, "127.0.0.1", async () => {
	const origin = `http://127.0.0.1:${server.address().port}`;
	const bodies = [];
	for (let i = 0; i < 20; i++) bodies.push(await get(origin));
	clearTimeout(watchdog);
	server.close(() => {
		const complete = bodies.every((body) => body === "ab");
		console.log(complete ? "HTTP SPLIT RESPONSE PASS" : `HTTP SPLIT RESPONSE ${bodies}`);
	});
});
