const http = require("node:http");

function fail(message) {
	throw new Error(message);
}

function expectThrow(label, callback, pattern) {
	try {
		callback();
	} catch (error) {
		if (!(error instanceof Error) || !pattern.test(error.message)) {
			fail(label + " wrong error: " + error);
		}
		return;
	}
	fail(label + " did not throw");
}

function read(response, expectedStatus, expectedBody, callback) {
	const chunks = [];
	if (response.statusCode !== expectedStatus) fail("status for " + expectedBody);
	response.on("data", (chunk) => chunks.push(chunk));
	response.on("end", () => {
		if (Buffer.concat(chunks).toString("utf8") !== expectedBody) {
			fail("response body for " + expectedBody);
		}
		callback();
	});
}

const server = http.createServer((request, response) => {
	if (request.url === "/stream") {
		let total = 0;
		request.on("data", (chunk) => {
			if (chunk.length > 0 && chunk[0] !== 117) fail("stream upload bytes");
			total += chunk.length;
		});
		request.on("end", () => {
			if (total !== 768 * 1024) fail("stream upload length");
			response.setHeader("Content-Length", String(768 * 1024));
			const chunk = Buffer.alloc(256 * 1024, 114);
			response.write(chunk);
			response.write(chunk);
			response.end(chunk);
		});
		return;
	}
	if (request.url === "/early") {
		response.end("early response");
		return;
	}
	if (request.url === "/head") {
		response.setHeader("Content-Length", "1024");
		response.end();
		return;
	}
	const chunks = [];
	request.on("data", (chunk) => chunks.push(chunk));
	request.on("end", () => {
		const body = Buffer.concat(chunks).toString("utf8");
		if (request.url === "/echo?value=1") {
			if (request.method !== "POST") fail("method");
			if (request.headers["x-loopback"] !== "yes") fail("request header");
			if (request.headers["x-request-dup"] !== "first, second") {
				fail("duplicate request header");
			}
			if (request.headers.cookie !== "request=one; second=two") {
				fail("request cookie header");
			}
			if (body !== "abcdef") fail("request body");
			response.statusCode = 425;
			response.setHeader("Content-Type", "text/plain");
			response.setHeader("X-Response-Dup", ["first", "second"]);
			response.setHeader("Cookie", ["response=one", "second=two"]);
			response.setHeader("Set-Cookie", ["loopback=yes; HttpOnly", "second=yes"]);
			response.end("received:" + body);
			return;
		}
		if (request.url === "/precedence?source=options") {
			if (request.headers["x-overload"] !== "url-object") fail("URL headers");
			response.end("url-object");
			return;
		}
		if (request.url === "/options-only") {
			if (request.headers["x-overload"] !== "options") fail("options headers");
			response.end("options-only");
			return;
		}
		if (request.url === "/host-precedence") {
			response.end("host-precedence");
			return;
		}
		if (request.url === "/get") {
			response.statusMessage = "Custom Get";
			response.end("get-auto-end");
			return;
		}
		response.statusCode = 404;
		response.end("unexpected: " + request.url);
	});
});

server.listen(0, "127.0.0.1", () => {
	const port = server.address().port;
	expectThrow(
		"protocol",
		() => http.request({ protocol: "https:", hostname: "localhost", port }),
		/protocol/i,
	);
	expectThrow("port", () => http.request({ hostname: "localhost", port: 65536 }), /port/);
	expectThrow(
		"path",
		() => http.request({ hostname: "localhost", port, path: "/bad path" }),
		/path/,
	);
	expectThrow(
		"hostname",
		() => http.request({ hostname: "example.com", port }),
		/hostname/,
	);
	expectThrow(
		"header name",
		() => http.request({ hostname: "localhost", port, headers: { "bad name": "x" } }),
		/header/i,
	);
	expectThrow(
		"header value",
		() => http.request({ hostname: "localhost", port, headers: { x: "bad\nvalue" } }),
		/header/i,
	);
	expectThrow(
		"undefined header value",
		() => http.request({ hostname: "localhost", port, headers: { x: undefined } }),
		/header/i,
	);

	const request = http.request(
		`http://localhost:${port}/echo?value=1`,
		{
			method: "post",
			headers: {
				"X-Loopback": "yes",
				"X-Request-Dup": ["first", "second"],
				Cookie: ["request=one", "second=two"],
			},
		},
		(response) => {
			if (response.statusMessage !== "Too Early") fail("status message");
			if (response.headers["content-type"] !== "text/plain") fail("response header");
			if (response.headers["x-response-dup"] !== "first, second") {
				fail("duplicate response header");
			}
			if (response.headers.cookie !== "response=one; second=two") {
				fail("response cookie header");
			}
			if (
				response.headers["set-cookie"].join("|") !== "loopback=yes; HttpOnly|second=yes"
			) {
				fail("set-cookie");
			}
			read(response, 425, "received:abcdef", runUrlObject);
		},
	);
	request.on("error", (error) => fail("unexpected error: " + error.message));
	request.write("abc");
	request.end("def");

	function runUrlObject() {
		const target = new URL(`https://example.com:${port}/ignored?source=url#hash`);
		const outgoing = http.request(
			target,
			{
				protocol: "http:",
				hostname: "127.0.0.1",
				path: "/precedence?source=options",
				headers: { "X-Overload": "url-object" },
			},
			(response) => read(response, 200, "url-object", runOptionsOnly),
		);
		if (!(outgoing instanceof http.ClientRequest)) fail("URL request return");
		outgoing.end();
	}

	function runOptionsOnly() {
		const outgoing = http.request(
			{
				host: "localhost",
				port,
				path: "/options-only",
				headers: { "X-Overload": "options" },
			},
			(response) => read(response, 200, "options-only", runHostPrecedence),
		);
		outgoing.end();
	}

	function runHostPrecedence() {
		const outgoing = http.request(
			`http://localhost:${port}/ignored`,
			{ host: "192.0.2.1", path: "/host-precedence" },
			(response) => read(response, 200, "host-precedence", runGet),
		);
		outgoing.end();
	}

	function runGet() {
		let endCalls = 0;
		const originalEnd = http.ClientRequest.prototype.end;
		http.ClientRequest.prototype.end = function () {
			endCalls++;
			return originalEnd.apply(this, arguments);
		};
		const outgoing = http.get(
			new URL(`https://example.com:${port}/ignored`),
			{ protocol: "http:", hostname: "127.0.0.1", path: "/get" },
			(response) => {
				if (response.statusMessage !== "Custom Get") fail("custom status message");
				read(response, 200, "get-auto-end", () => {
					if (endCalls !== 1) fail("get end count");
					http.ClientRequest.prototype.end = originalEnd;
					runHead();
				});
			},
		);
		if (!(outgoing instanceof http.ClientRequest)) fail("get return");
	}

	function runHead() {
		const outgoing = http.request(
			{
				hostname: "127.0.0.1",
				port,
				path: "/head",
				method: "HEAD",
			},
			(response) => {
				let length = 0;
				response.on("data", (chunk) => (length += chunk.length));
				response.on("end", () => {
					if (length !== 0) fail("HEAD response body");
					if (!response.complete) fail("HEAD response completion");
					runStreaming();
				});
			},
		);
		outgoing.on("error", (error) => fail("HEAD error: " + error.message));
		outgoing.end();
	}

	function runStreaming() {
		let responseEnded = false;
		let requestClosed = false;
		let responseLength = 0;
		let responseChunks = 0;
		let writeCallbacks = 0;
		let finishCallbacks = 0;
		let drains = 0;
		const outgoing = http.request(
			{
				hostname: "127.0.0.1",
				port,
				path: "/stream",
				method: "POST",
				headers: { "Content-Length": String(768 * 1024) },
			},
			(response) => {
				if (response.statusCode !== 200) fail("stream response status");
				response.on("data", (chunk) => {
					if (chunk.length > 0 && chunk[0] !== 114) fail("stream response bytes");
					responseLength += chunk.length;
					responseChunks++;
				});
				response.on("end", () => {
					responseEnded = true;
					if (responseLength !== 768 * 1024) fail("stream response length");
					if (responseChunks < 2) fail("stream response chunks");
					maybeContinue();
				});
			},
		);
		outgoing.on("error", (error) => fail("stream error: " + error.message));
		outgoing.on("drain", () => drains++);
		outgoing.on("close", () => {
			requestClosed = true;
			if (writeCallbacks !== 1) fail("stream write callback");
			if (finishCallbacks !== 1) fail("stream finish callback");
			if (drains !== 1) fail("stream drain count");
			maybeContinue();
		});
		if (outgoing.write(Buffer.alloc(384 * 1024, 117), () => writeCallbacks++) !== false) {
			fail("stream write backpressure");
		}
		outgoing.end(Buffer.alloc(384 * 1024, 117), () => finishCallbacks++);

		function maybeContinue() {
			if (responseEnded && requestClosed) runEarlyResponse();
		}
	}

	function runEarlyResponse() {
		const chunks = [];
		let responseEnded = false;
		let requestClosed = false;
		const outgoing = http.request(
			{
				hostname: "127.0.0.1",
				port,
				path: "/early",
				method: "POST",
				headers: { "Content-Length": String(32 * 1024) },
			},
			(response) => {
				outgoing.end(Buffer.alloc(32 * 1024 - 5, 101));
				response.on("data", (chunk) => chunks.push(chunk));
				response.on("end", () => {
					responseEnded = true;
					if (Buffer.concat(chunks).toString("utf8") !== "early response") {
						fail("early response body");
					}
					maybeClose();
				});
			},
		);
		outgoing.on("error", (error) => fail("early response error: " + error.message));
		outgoing.on("close", () => {
			requestClosed = true;
			maybeClose();
		});
		outgoing.write("hello");

		function maybeClose() {
			if (responseEnded && requestClosed) closeServer();
		}
	}

	function closeServer() {
		server.close(() => {
			const refused = http.request(`http://127.0.0.1:${port}/closed`);
			refused.on("error", (error) => {
				if (!(error instanceof Error)) fail("error object");
				console.log("HTTP CLIENT LOOPBACK PASS");
			});
			refused.end();
		});
	}
});
