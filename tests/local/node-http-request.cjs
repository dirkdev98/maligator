const http = require("node:http");

const concurrentResponses = [];
let completedResponse;

Object.defineProperty(Object.prototype, "__httpSocketRealmMarker", {
	value: "request-realm",
	writable: true,
	enumerable: false,
	configurable: true,
});

Object.defineProperty(http.IncomingMessage.prototype, "__httpRequestRealmMarker", {
	value: "request-realm",
	writable: true,
	enumerable: false,
	configurable: true,
});

Object.defineProperty(http.ServerResponse.prototype, "__httpResponseRealmMarker", {
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

	if (request.url === "/response-shape") {
		const visibleDataProperty = (receiver, name, value) => {
			const descriptor = Object.getOwnPropertyDescriptor(receiver, name);
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
			Object.getOwnPropertyNames(request).join(",") ===
				"_events,_eventsCount,_maxListeners,destroyed,_malStreamKind,_readableState,_malReadableQueue,_malBlockedPipes,_malReadableIndex,_malFlowing,_malPaused,readable,readableEnded,method,url,headers,rawHeaders,httpVersion,httpVersionMajor,httpVersionMinor,complete,aborted,upgrade,trailers,rawTrailers,socket,connection",
			Object.keys(request).join(",") ===
				"_events,_eventsCount,_maxListeners,destroyed,_malStreamKind,_readableState,_malReadableQueue,_malBlockedPipes,_malReadableIndex,_malFlowing,_malPaused,readable,readableEnded,method,url,headers,rawHeaders,httpVersion,httpVersionMajor,httpVersionMinor,complete,aborted,upgrade,trailers,rawTrailers,socket,connection",
			visibleDataProperty(request, "method", "GET"),
			visibleDataProperty(request, "url", "/response-shape"),
			visibleDataProperty(request, "headers", request.headers),
			visibleDataProperty(request, "rawHeaders", request.rawHeaders),
			visibleDataProperty(request, "httpVersion", "1.1"),
			visibleDataProperty(request, "httpVersionMajor", 1),
			visibleDataProperty(request, "httpVersionMinor", 1),
			visibleDataProperty(request, "complete", true),
			visibleDataProperty(request, "aborted", false),
			visibleDataProperty(request, "upgrade", false),
			visibleDataProperty(request, "trailers", request.trailers),
			visibleDataProperty(request, "rawTrailers", request.rawTrailers),
			visibleDataProperty(request, "socket", request.socket),
			visibleDataProperty(request, "connection", request.socket),
			request.socket === request.connection,
			request.socket === response.socket,
			Object.getPrototypeOf(request) === http.IncomingMessage.prototype,
			request instanceof http.IncomingMessage,
			request.__httpRequestRealmMarker === "request-realm",
			!Object.prototype.hasOwnProperty.call(request, "__httpRequestRealmMarker"),
			Array.isArray(request.rawHeaders),
			Array.isArray(request.rawTrailers),
			request.trailers !== request.headers,
			Object.getOwnPropertyNames(response).join(",") ===
				"_events,_eventsCount,_maxListeners,destroyed,_malStreamKind,statusCode,statusMessage,headersSent,finished,writableEnded,writableFinished,socket,connection",
			Object.keys(response).join(",") ===
				"_events,_eventsCount,_maxListeners,destroyed,_malStreamKind,statusCode,statusMessage,headersSent,finished,writableEnded,writableFinished,socket,connection",
			visibleDataProperty(response, "socket", request.socket),
			visibleDataProperty(response, "connection", request.socket),
			response.socket === response.connection,
			response.socket === request.socket,
			Object.getPrototypeOf(response) === http.ServerResponse.prototype,
			response instanceof http.ServerResponse,
			response.__httpResponseRealmMarker === "request-realm",
			!Object.prototype.hasOwnProperty.call(response, "__httpResponseRealmMarker"),
			response._malStreamKind === 0,
			visibleDataProperty(response, "statusCode", 200),
			visibleDataProperty(response, "statusMessage", undefined),
			visibleDataProperty(response, "headersSent", false),
			visibleDataProperty(response, "finished", false),
			visibleDataProperty(response, "writableEnded", false),
			visibleDataProperty(response, "writableFinished", false),
		];
		response.statusCode = checks.every(Boolean) ? 200 : 500;
		response.end(checks.every(Boolean) ? "ok" : "response shape mismatch");
		return;
	}

	if (request.url === "/prepare-unusual-response") {
		Object.defineProperty(http.IncomingMessage.prototype, "_malStreamKind", {
			set(_value) {},
			configurable: true,
		});
		Object.defineProperty(http.ServerResponse.prototype, "_malStreamKind", {
			set(_value) {},
			configurable: true,
		});
		response.end("prepared");
		return;
	}

	if (request.url === "/unusual-response-shape") {
		delete http.IncomingMessage.prototype._malStreamKind;
		delete http.ServerResponse.prototype._malStreamKind;
		const requestNames = Object.getOwnPropertyNames(request);
		const names = Object.getOwnPropertyNames(response);
		const methodDescriptor = Object.getOwnPropertyDescriptor(request, "method");
		const requestSocketDescriptor = Object.getOwnPropertyDescriptor(request, "socket");
		const requestConnectionDescriptor = Object.getOwnPropertyDescriptor(
			request,
			"connection",
		);
		const socketDescriptor = Object.getOwnPropertyDescriptor(response, "socket");
		const connectionDescriptor = Object.getOwnPropertyDescriptor(response, "connection");
		const constructorDefaults = [
			["statusCode", 200],
			["statusMessage", undefined],
			["headersSent", false],
			["finished", false],
			["writableEnded", false],
			["writableFinished", false],
		];
		const constructorDescriptorsMatch = constructorDefaults.every(([name, value]) => {
			const descriptor = Object.getOwnPropertyDescriptor(response, name);
			return (
				descriptor !== undefined &&
				descriptor.value === value &&
				descriptor.writable === true &&
				descriptor.enumerable === true &&
				descriptor.configurable === true &&
				descriptor.get === undefined &&
				descriptor.set === undefined
			);
		});
		const checks = [
			!Object.prototype.hasOwnProperty.call(request, "_malStreamKind"),
			request._malStreamKind === undefined,
			requestNames.slice(-14).join(",") ===
				"method,url,headers,rawHeaders,httpVersion,httpVersionMajor,httpVersionMinor,complete,aborted,upgrade,trailers,rawTrailers,socket,connection",
			methodDescriptor.value === "GET",
			methodDescriptor.writable === true,
			methodDescriptor.enumerable === true,
			methodDescriptor.configurable === true,
			requestSocketDescriptor.value === request.connection,
			requestSocketDescriptor.writable === true,
			requestSocketDescriptor.enumerable === true,
			requestSocketDescriptor.configurable === true,
			requestConnectionDescriptor.value === request.socket,
			requestConnectionDescriptor.writable === true,
			requestConnectionDescriptor.enumerable === true,
			requestConnectionDescriptor.configurable === true,
			Object.getPrototypeOf(request) === http.IncomingMessage.prototype,
			request.__httpRequestRealmMarker === "request-realm",
			!Object.prototype.hasOwnProperty.call(response, "_malStreamKind"),
			response._malStreamKind === undefined,
			names.slice(-8).join(",") ===
				"statusCode,statusMessage,headersSent,finished,writableEnded,writableFinished,socket,connection",
			constructorDescriptorsMatch,
			socketDescriptor.value === request.socket,
			socketDescriptor.writable === true,
			socketDescriptor.enumerable === true,
			socketDescriptor.configurable === true,
			connectionDescriptor.value === request.socket,
			connectionDescriptor.writable === true,
			connectionDescriptor.enumerable === true,
			connectionDescriptor.configurable === true,
			Object.getPrototypeOf(response) === http.ServerResponse.prototype,
			response.__httpResponseRealmMarker === "request-realm",
		];
		response.statusCode = checks.every(Boolean) ? 200 : 500;
		response.end(checks.every(Boolean) ? "ok" : "response fallback mismatch");
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
				let nameCoercions = 0;
				const mixedName = {
					toString() {
						nameCoercions++;
						return "x-InDeX";
					},
				};
				entry.response.setHeader("X-Index", entry.id);
				entry.response.setHeader(mixedName, entry.id);
				const setCoercedOnce = nameCoercions === 1;
				const mixedValue = entry.response.getHeader(mixedName);
				const getCoercedOnce = nameCoercions === 2;
				const mixedPresent = entry.response.hasHeader(mixedName);
				const hasCoercedOnce = nameCoercions === 3;
				entry.response.setHeader("X-Removed", "yes");
				entry.response.removeHeader("X-Missing");
				entry.response.removeHeader(mixedName);
				const removeCoercedOnce = nameCoercions === 4;
				entry.response.setHeader("X-InDeX", entry.id);
				const readdedOrder = entry.response.getHeaderNames().join(",");
				entry.response.removeHeader("X-Removed");
				if (
					mixedValue !== entry.id ||
					!mixedPresent ||
					!setCoercedOnce ||
					!getCoercedOnce ||
					!hasCoercedOnce ||
					!removeCoercedOnce ||
					readdedOrder !== "x-removed,x-index" ||
					entry.response.getHeader("X-iNdEx") !== entry.id ||
					!entry.response.hasHeader("x-INDeX") ||
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
