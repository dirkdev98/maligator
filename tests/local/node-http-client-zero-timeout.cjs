const http = require("node:http");

const port = Number(process.env.MAL_HTTP_TIMEOUT_PORT);
const modes = ["option", "before-send", "after-response"];

function run(index) {
	if (index === modes.length) {
		console.log("HTTP CLIENT ZERO TIMEOUT PASS");
		return;
	}
	const mode = modes[index];
	const request = http.request({
		hostname: "127.0.0.1",
		port,
		path: "/timeout-disabled",
		timeout: 0,
		agent: false,
	});
	const unexpectedTimeout = () => {
		throw new Error("disabled timeout fired: " + mode);
	};
	const disable = () => {
		request.setTimeout(40);
		if (request.setTimeout(0) !== request) {
			throw new Error("setTimeout must return the request");
		}
	};
	request.on("timeout", unexpectedTimeout);
	request.on("error", (error) => {
		throw error;
	});
	if (mode === "before-send") disable();
	request.on("response", (response) => {
		if (mode === "after-response") disable();
		let body = "";
		response.on("data", (chunk) => (body += chunk.toString()));
		response.on("end", () => {
			if (body !== "ok") throw new Error("incomplete response: " + mode);
			run(index + 1);
		});
	});
	request.end();
}

run(0);
