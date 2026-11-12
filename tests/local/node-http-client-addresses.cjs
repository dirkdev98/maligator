const assert = require("node:assert/strict");
const http = require("node:http");

const request = http.request(
	{
		hostname: "localhost",
		port: Number(process.env.MAL_HTTP_ADDRESS_PORT),
		method: "POST",
		path: "/hostname",
		agent: false,
	},
	(response) => {
		let body = "";
		response.setEncoding("utf8");
		response.on("data", (chunk) => {
			body += chunk;
		});
		response.on("end", () => {
			assert.equal(body, "through-hostname");
			console.log("HTTP ADDRESS FALLBACK PASS");
		});
	},
);
request.on("error", (error) => {
	console.error(error);
	process.exitCode = 1;
});
request.write("through-");
request.end("hostname");
