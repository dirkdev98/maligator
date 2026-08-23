const http = require("node:http");

const concurrentResponses = [];
let completedResponse;
let streamEvents = [];
let failedWriteEvents = [];
let endBeforeDrainEvents = [];
let earlyUploadTotal = 0;
let earlyUploadEnded = false;
let earlyUnreadEnded = false;
let abortedUpload = "0:false:false:false";
let destroyedUpload = "false:false:false:0";
let malformedUpload = "false:false:false";

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
	if (request.url === "/many-headers") {
		let valid = true;
		for (let i = 0; i < 40; i++) {
			const suffix = i < 10 ? "0" + i : String(i);
			valid =
				valid &&
				request.headers["x-request-" + suffix] ===
					"value-" + suffix + "-abcdefghijklmnopqrstuvwxyz0123456789";
		}
		for (let i = 0; i < 24; i++) {
			response.setHeader("X-Response-" + i, "reply-" + i);
		}
		response.statusCode = valid ? 200 : 500;
		response.end(valid ? "many" : "many header mismatch");
		return;
	}

	if (request.url === "/header-snapshot") {
		const setCookies = request.headers["set-cookie"];
		let valid =
			request.rawHeaders.join("|") ===
				"Host|127.0.0.1|X-Mixed|first|x-MIXED|second|Cookie|a=1|cookie|b=2|Set-Cookie|one=1|set-cookie|two=2|Authorization|first|authorization|second|X-Order|third|Connection|close" &&
			request.headers.host === "127.0.0.1" &&
			request.headers["x-mixed"] === "first, second" &&
			request.headers.cookie === "a=1; b=2" &&
			setCookies.join("|") === "one=1|two=2" &&
			request.headers.authorization === "first" &&
			request.headers["x-order"] === "third";
		const mixedRawValue = request.rawHeaders.indexOf("X-Mixed") + 1;
		const cookieRawValue = request.rawHeaders.indexOf("Set-Cookie") + 1;
		request.rawHeaders[mixedRawValue] = "raw-only";
		setCookies[0] = "array-only";
		valid =
			valid &&
			request.headers["x-mixed"] === "first, second" &&
			request.rawHeaders[cookieRawValue] === "one=1";
		request.headers["x-mixed"] = "headers-only";
		valid = valid && request.rawHeaders[mixedRawValue] === "raw-only";
		response.statusCode = valid ? 200 : 500;
		response.end(valid ? "ok" : "header snapshot mismatch");
		return;
	}

	if (request.url.startsWith("/header-reuse/")) {
		const id = request.url.slice(14);
		const spelling = id === "first" ? "X-ReUsEd" : "x-rEuSeD";
		const expected = id === "first" ? "first-value" : "second-value";
		if (typeof __mal_collect_garbage === "function") __mal_collect_garbage();
		const offset = request.rawHeaders.indexOf(spelling);
		const valid =
			(id === "first" || id === "second") &&
			offset >= 0 &&
			request.rawHeaders[offset + 1] === expected &&
			request.headers["x-reused"] === expected &&
			request.headers[spelling] === undefined;
		response.statusCode = valid ? 200 : 500;
		response.end(valid ? `reuse:${id}` : "header reuse mismatch");
		return;
	}

	if (request.url === "/socket-shape") {
		const socket = request.socket;
		const address = socket.address();
		const secondAddress = socket.address();
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
			Object.getOwnPropertyNames(socket).join(",") ===
				"_events,_eventsCount,_maxListeners,encrypted,readable,writable,remoteAddress,remotePort,remoteFamily,localAddress,localPort,localFamily,address",
			Object.keys(socket).join(",") ===
				"_events,_eventsCount,_maxListeners,encrypted,readable,writable,remoteAddress,remotePort,remoteFamily,localAddress,localPort,localFamily,address",
			visibleDataProperty("encrypted", false),
			visibleDataProperty("readable", true),
			visibleDataProperty("writable", true),
			visibleDataProperty("remoteAddress", "127.0.0.1"),
			visibleDataProperty("remotePort", socket.remotePort),
			Number.isInteger(socket.remotePort) && socket.remotePort > 0,
			visibleDataProperty("remoteFamily", "IPv4"),
			visibleDataProperty("localAddress", "127.0.0.1"),
			visibleDataProperty("localPort", server.address().port),
			visibleDataProperty("localFamily", "IPv4"),
			visibleDataProperty("address", socket.address),
			typeof socket.address === "function" && socket.address.length === 0,
			address !== secondAddress,
			address.address === socket.localAddress,
			address.family === socket.localFamily,
			address.port === socket.localPort,
			Object.getPrototypeOf(socket) ===
				Object.getPrototypeOf(Object.getPrototypeOf(server)),
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
				"_events,_eventsCount,_maxListeners,destroyed,_malStreamKind,_readableState,_malReadableQueue,_malBlockedPipes,_malReadableIndex,_malFlowing,_malPaused,_malReading,_malReadScheduled,readable,readableEnded,method,url,headers,rawHeaders,httpVersion,httpVersionMajor,httpVersionMinor,complete,aborted,upgrade,trailers,rawTrailers,socket,connection",
			Object.keys(request).join(",") ===
				"_events,_eventsCount,_maxListeners,destroyed,_malStreamKind,_readableState,_malReadableQueue,_malBlockedPipes,_malReadableIndex,_malFlowing,_malPaused,_malReading,_malReadScheduled,readable,readableEnded,method,url,headers,rawHeaders,httpVersion,httpVersionMajor,httpVersionMinor,complete,aborted,upgrade,trailers,rawTrailers,socket,connection",
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
				const mixedName = "x-InDeX";
				entry.response.setHeader("X-Index", entry.id);
				entry.response.setHeader(mixedName, entry.id);
				const mixedValue = entry.response.getHeader(mixedName);
				const mixedPresent = entry.response.hasHeader(mixedName);
				entry.response.setHeader("X-Removed", "yes");
				entry.response.removeHeader("X-Missing");
				entry.response.removeHeader(mixedName);
				entry.response.setHeader("X-InDeX", entry.id);
				const readdedOrder = entry.response.getHeaderNames().join(",");
				entry.response.removeHeader("X-Removed");
				if (
					mixedValue !== entry.id ||
					!mixedPresent ||
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

	if (request.url === "/stream-upload") {
		const chunks = [];
		let total = 0;
		let maxChunk = 0;
		let paused = false;
		let dataWhilePaused = false;
		const initialComplete = request.complete;
		request.on("data", (chunk) => {
			if (paused) dataWhilePaused = true;
			chunks.push(chunk);
			total += chunk.length;
			if (chunk.length > maxChunk) maxChunk = chunk.length;
			if (chunks.length === 1) {
				paused = true;
				request.pause();
				setTimeout(() => {
					paused = false;
					request.resume();
				}, 20);
			}
		});
		request.on("end", () => {
			response.setHeader("X-Initial-Complete", String(initialComplete));
			response.setHeader("X-Final-Complete", String(request.complete));
			response.setHeader("X-Max-Chunk", String(maxChunk));
			response.setHeader("X-Chunk-Count", String(chunks.length));
			response.setHeader("X-Data-While-Paused", String(dataWhilePaused));
			const body = Buffer.concat(chunks);
			response.end(`${total}:${body[0]}:${body[body.length - 1]}`);
		});
		return;
	}

	if (request.url === "/chunked-upload") {
		const chunks = [];
		request.on("data", (chunk) => chunks.push(chunk));
		request.on("end", () => response.end(Buffer.concat(chunks)));
		return;
	}

	if (request.url === "/malformed-upload") {
		let aborted = false;
		let finished = false;
		let closed = false;
		const update = () => {
			malformedUpload = `${aborted}:${finished}:${closed}`;
		};
		request.on("data", () => {});
		request.on("aborted", () => {
			aborted = true;
			update();
		});
		response.on("finish", () => {
			finished = true;
			update();
		});
		response.on("close", () => {
			closed = true;
			update();
		});
		return;
	}

	if (request.url === "/malformed-upload-status") {
		response.end(malformedUpload);
		return;
	}

	if (request.url === "/early-upload") {
		earlyUploadTotal = 0;
		earlyUploadEnded = false;
		request.on("data", (chunk) => (earlyUploadTotal += chunk.length));
		request.on("end", () => (earlyUploadEnded = true));
		response.end("early");
		return;
	}

	if (request.url === "/early-upload-status") {
		response.end(`${earlyUploadTotal}:${earlyUploadEnded}`);
		return;
	}

	if (request.url === "/early-unread") {
		earlyUnreadEnded = false;
		request.on("end", () => (earlyUnreadEnded = true));
		response.end("unread");
		return;
	}

	if (request.url === "/early-unread-status") {
		response.end(String(earlyUnreadEnded));
		return;
	}

	if (request.url === "/aborted-upload") {
		let total = 0;
		let aborted = false;
		let ended = false;
		let closed = false;
		const update = () => {
			abortedUpload = `${total}:${aborted}:${ended}:${closed}`;
		};
		request.on("data", (chunk) => {
			total += chunk.length;
			update();
		});
		request.on("aborted", () => {
			aborted = true;
			update();
		});
		request.on("end", () => {
			ended = true;
			update();
		});
		request.on("close", () => {
			closed = true;
			update();
		});
		return;
	}

	if (request.url === "/aborted-upload-status") {
		response.end(abortedUpload);
		return;
	}

	if (request.url === "/destroyed-upload") {
		let synchronous = false;
		let aborted = false;
		let errored = false;
		let closes = 0;
		const update = () => {
			destroyedUpload = `${synchronous}:${aborted}:${errored}:${closes}`;
		};
		request.on("aborted", () => {
			aborted = true;
			update();
		});
		request.on("error", (error) => {
			errored = error.message === "stop upload";
			update();
		});
		request.on("close", () => {
			closes++;
			update();
		});
		request.on("data", () => {
			const returned = request.destroy(new Error("stop upload"));
			synchronous =
				request.destroyed &&
				request.readable === false &&
				request._readableState.destroyed &&
				returned === request;
			update();
		});
		return;
	}

	if (request.url === "/destroyed-upload-status") {
		response.end(destroyedUpload);
		return;
	}

	if (request.url === "/no-body") {
		response.statusCode = 204;
		response.end("must-not-be-sent");
		return;
	}

	if (request.url === "/stream-backpressure") {
		streamEvents = [];
		const chunk = Buffer.alloc(64 * 1024, 120);
		response.on("finish", () => streamEvents.push("finish"));
		for (let i = 0; i < 4; i++) {
			const accepted = response.write(chunk, () => streamEvents.push(`write:${i}`));
			streamEvents.push(`return:${accepted}`);
		}
		response.once("drain", () => {
			streamEvents.push("drain");
			response.end("tail");
		});
		return;
	}

	if (request.url === "/stream-backpressure-events") {
		response.end(streamEvents.join(","));
		return;
	}

	if (request.url === "/end-before-drain") {
		endBeforeDrainEvents = [];
		const chunk = Buffer.alloc(64 * 1024, 120);
		response.on("drain", () => endBeforeDrainEvents.push("drain"));
		response.on("finish", () => endBeforeDrainEvents.push("finish"));
		for (let i = 0; i < 4; i++) response.write(chunk);
		response.end("tail", () => endBeforeDrainEvents.push("end"));
		return;
	}

	if (request.url === "/end-before-drain-events") {
		response.end(endBeforeDrainEvents.join(","));
		return;
	}

	if (request.url === "/wire-stream") {
		response.setHeader("Connection", "close");
		response.write("ab");
		response.write(Buffer.from("cde"));
		response.end("f");
		return;
	}

	if (request.url === "/fixed-stream") {
		response.setHeader("Content-Length", "6");
		response.write("ab");
		response.end("cdef");
		return;
	}

	if (request.url === "/failed-write") {
		failedWriteEvents = [];
		response.on("close", () => failedWriteEvents.push("close"));
		const chunk = Buffer.alloc(256 * 1024, 120);
		for (let i = 0; i < 16; i++) {
			response.write(chunk, (error) => {
				failedWriteEvents.push(`write:${i}:${error instanceof Error}`);
			});
		}
		response.end("tail", (error) => {
			failedWriteEvents.push(`end:${error instanceof Error}`);
		});
		return;
	}

	if (request.url === "/failed-write-events") {
		response.end(failedWriteEvents.join(","));
		return;
	}

	if (request.url === "/short-content-length") {
		response.setHeader("Content-Length", "2");
		response.end("x");
		return;
	}

	if (request.url === "/long-content-length") {
		response.setHeader("Content-Length", "1");
		response.end("xx");
		return;
	}

	if (request.url === "/head-explicit") {
		response.setHeader("Content-Length", "2");
		response.write("a");
		response.end("b");
		return;
	}

	if (request.url === "/reentrant-commit") {
		Object.defineProperty(response, "statusCode", {
			configurable: true,
			get() {
				response.write("nested");
				return 200;
			},
		});
		response.write("outer");
		return;
	}

	if (request.url === "/remove-after-write") {
		response.setHeader("X-Test", "yes");
		response.write("a");
		try {
			response.removeHeader("X-Test");
		} catch (error) {
			response.end(error.message);
		}
		return;
	}

	if (request.url.startsWith("/invalid-content-length/")) {
		response.setHeader("Content-Length", request.url.slice(24));
		try {
			response.end("x");
		} catch (error) {
			response.removeHeader("Content-Length");
			response.statusCode = 500;
			response.end(error.message);
		}
		return;
	}

	if (request.url === "/throw-after-write") {
		response.write("partial");
		throw new Error("after write");
	}

	if (request.url === "/throw-during-upload") {
		throw new Error("upload handler failed");
	}

	if (request.url === "/close-during-upload") {
		let total = 0;
		let closing = false;
		request.on("data", (chunk) => {
			total += chunk.length;
			if (!closing) {
				closing = true;
				server.close();
			}
		});
		request.on("end", () => response.end(String(total)));
		return;
	}

	if (request.url === "/idle-stream") {
		response.write("idle");
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
		response.on("finish", () => {
			server.close();
			server.closeAllConnections();
		});
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
