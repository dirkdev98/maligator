const http = require("node:http");

const concurrentResponses = [];
let completedResponse;

Object.defineProperty(Object.prototype, "__httpSocketRealmMarker", {
	value: "request-realm",
	writable: true,
	enumerable: false,
	configurable: true,
});

function throwsMessage(callback, message) {
	try {
		callback();
		return false;
	} catch (error) {
		return error.message === message;
	}
}

const server = http.createServer(function (request, response) {
	if (request.url === "/header-snapshot") {
		const valid =
			request.rawHeaders.join("|") ===
				"Host|127.0.0.1|X-Mixed|first|x-MIXED|second|X-Order|third|Connection|close" &&
			request.headers.host === "127.0.0.1" &&
			request.headers["x-mixed"] === "second" &&
			request.headers["x-order"] === "third";
		response.statusCode = valid ? 200 : 500;
		response.end(valid ? "ok" : "header snapshot mismatch");
		return;
	}

	if (request.url === "/socket-shape") {
		const socket = request.socket;
		const visibleDataProperty = (name, value) => {
			const descriptor = Object.getOwnPropertyDescriptor(socket, name);
			return (
				descriptor !== undefined &&
				descriptor.value === value &&
				descriptor.writable === true &&
				descriptor.enumerable === true &&
				descriptor.configurable === true &&
				descriptor.get === undefined &&
				descriptor.set === undefined
			);
		};
		const checks = [
			Object.getOwnPropertyNames(socket).join(",") === "encrypted,readable,writable",
			Object.keys(socket).join(",") === "encrypted,readable,writable",
			visibleDataProperty("encrypted", false),
			visibleDataProperty("readable", true),
			visibleDataProperty("writable", true),
			Object.getPrototypeOf(socket) === Object.prototype,
			socket.__httpSocketRealmMarker === "request-realm",
			!Object.prototype.hasOwnProperty.call(socket, "__httpSocketRealmMarker"),
			request.socket === request.connection,
			request.socket === response.socket,
			response.socket === response.connection,
		];
		response.statusCode = checks.every(Boolean) ? 200 : 500;
		response.end(checks.every(Boolean) ? "ok" : "socket shape mismatch");
		return;
	}

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

	if (request.url.startsWith("/concurrent/")) {
		concurrentResponses.push({ response, id: request.url.slice(12) });
		if (concurrentResponses.length === 16) {
			const batch = concurrentResponses.splice(0);
			for (const entry of batch) {
				entry.response.setHeader("X-Index", entry.id);
				entry.response.setHeader("X-Removed", "yes");
				entry.response.removeHeader("X-Removed");
				if (
					entry.response.getHeader("x-index") !== entry.id ||
					!entry.response.hasHeader("X-Index") ||
					entry.response.hasHeader("X-Removed") ||
					entry.response.getHeaders()["x-index"] !== entry.id ||
					entry.response.getHeaderNames()[0] !== "x-index"
				) {
					entry.response.statusCode = 500;
				}
				entry.response.write("batch:");
				entry.response.end(entry.id);
			}
			completedResponse = batch[0].response;
		}
		return;
	}

	if (request.url === "/receiver-check") {
		const prototype = http.ServerResponse.prototype;
		const forged = {};
		const constructed = new http.ServerResponse();
		const checks = [
			prototype.getHeader.call(forged, "x") === undefined,
			prototype.hasHeader.call(forged, "x") === false,
			prototype.removeHeader.call(forged, "x") === undefined,
			Object.keys(prototype.getHeaders.call(forged)).length === 0,
			prototype.getHeaderNames.call(forged).length === 0,
			throwsMessage(
				() => prototype.setHeader.call(forged, "x", "y"),
				"ServerResponse is not writable",
			),
			throwsMessage(() => prototype.write.call(forged, "x"), "write after end"),
			throwsMessage(() => prototype.end.call(forged), "write after end"),
			constructed.getHeader("x") === undefined,
			completedResponse.getHeader("x-index") === undefined,
			throwsMessage(
				() => completedResponse.setHeader("x", "y"),
				"ServerResponse is not writable",
			),
		];
		response.statusCode = checks.every(Boolean) ? 200 : 500;
		response.end(checks.every(Boolean) ? "ok" : "receiver mismatch");
		return;
	}

	if (request.url === "/async") {
		setTimeout(() => {
			response.setHeader("X-Async", "yes");
			response.end(response.getHeader("x-async"));
		}, 0);
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

	if (request.url === "/connection-close") {
		response.setHeader("Connection", "close");
		response.end("connection-closed");
		return;
	}

	response.statusCode = 404;
	response.end("missing");
});

server.listen(0, "127.0.0.1", () => {
	console.log("PORT " + server.address().port);
});
