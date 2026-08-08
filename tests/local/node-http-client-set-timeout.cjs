const http = require("node:http");

// Same silent peer as node-http-client-timeout.cjs, reached through the
// setTimeout entry point instead of the request option.
const port = Number(process.env.MAL_HTTP_TIMEOUT_PORT);
const events = [];
const request = http.request({
	hostname: "127.0.0.1",
	port,
	path: "/silent",
});

request.setTimeout(40, () => events.push("callback"));
request.on("timeout", () => events.push("timeout"));
request.on("error", (error) => {
	events.push("error");
	if (error?.code !== "ETIMEDOUT") {
		throw new Error("wrong timeout error code: " + error?.code);
	}
});
request.on("close", () => {
	events.push("close");
	if (events.join(",") !== "callback,timeout,error,close") {
		throw new Error("wrong timeout event order: " + events.join(","));
	}
	console.log("HTTP CLIENT SET TIMEOUT PASS");
});
request.end();
