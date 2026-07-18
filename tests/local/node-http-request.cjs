const http = require("node:http");

const server = http.createServer(function (request, response) {
	if (request.url === "/metadata") {
		const valid =
			this === server &&
			request instanceof http.IncomingMessage &&
			response instanceof http.ServerResponse &&
			(request.method === "GET" || request.method === "HEAD") &&
			request.headers["x-test"] === "request-header" &&
			request.httpVersion === "1.1" &&
			request.complete === true &&
			request.socket === request.connection &&
			response.socket === response.connection;
		response.statusCode = valid ? 201 : 500;
		response.setHeader("X-Reply", "response-header");
		response.write("a");
		response.end(Buffer.from("b"));
		return;
	}

	if (request.url === "/echo") {
		const chunks = [];
		request.on("data", (chunk) => chunks.push(chunk));
		request.on("end", () => {
			response.setHeader("Content-Type", "text/plain");
			response.end(Buffer.concat(chunks));
		});
		return;
	}

	if (request.url === "/no-body") {
		response.statusCode = 204;
		response.end("must-not-be-sent");
		return;
	}

	if (request.url === "/reentrant") {
		response.setHeader("X-Reentrant", {
			toString() {
				response.end("nested");
				return "unsafe";
			},
		});
		response.end("outer");
		return;
	}

	if (request.url === "/throw-after-end") {
		response.end("already-ended");
		throw new Error("after end");
	}

	if (request.url === "/close") {
		response.on("finish", () => server.close());
		response.end("closed");
		return;
	}

	response.statusCode = 404;
	response.end("missing");
});

server.listen(0, "127.0.0.1", () => {
	console.log("PORT " + server.address().port);
});
