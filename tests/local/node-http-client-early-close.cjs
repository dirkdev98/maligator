const http = require("node:http");

const port = Number(process.env.MAL_HTTP_EARLY_CLOSE_PORT);
let responseEnded = false;
let requestErrored = false;

const request = http.request(
	{
		hostname: "127.0.0.1",
		port,
		path: "/early-close",
		method: "POST",
		headers: { "Content-Length": String(32 * 1024) },
	},
	(response) => {
		if (response.statusCode !== 413) throw new Error("early close status");
		response.on("data", () => {
			throw new Error("early close body");
		});
		response.on("end", () => {
			responseEnded = true;
		});
	},
);

request.on("error", (error) => {
	if (!(error instanceof Error)) throw new Error("early close error object");
	requestErrored = true;
});
request.on("close", () => {
	if (!responseEnded) throw new Error("early close response completion");
	if (!requestErrored) throw new Error("early close request error");
	console.log("HTTP CLIENT EARLY CLOSE PASS");
});
request.write("hello");
