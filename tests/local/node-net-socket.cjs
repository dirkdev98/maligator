const http = require("node:http");
const net = require("node:net");
const stream = require("node:stream");

let failures = 0;

function check(condition, name) {
	if (!condition) {
		failures++;
		console.log("FAIL: " + name);
	}
}

function finish() {
	if (failures !== 0) throw new Error("node:net failures: " + failures);
	console.log("NODE NET PASS");
}

check(net.isIP("127.0.0.1") === 4, "IPv4 detection");
check(net.isIP("::1") === 6, "IPv6 detection");
check(net.isIP("localhost") === 0, "hostname is not an IP");
check(net.isIP(123) === 0, "non-string is not an IP");

const server = http.createServer((request, response) => {
	const chunks = [];
	request.on("data", (chunk) => chunks.push(chunk));
	request.on("end", () => {
		const body = Buffer.concat(chunks);
		check(request.method === "POST", "request method");
		response.setHeader("Connection", "close");
		if (request.url === "/socket") {
			check(body.toString("utf8") === "request-body", "request body");
			response.end("socket-response");
			return;
		}
		if (request.url === "/large") {
			check(body.length === 400000, "large request body");
			response.end("b".repeat(200000));
			return;
		}
		check(false, "request path");
		response.end("unexpected");
	});
});

server.listen(0, "127.0.0.1", () => {
	const port = server.address().port;
	const socket = new net.Socket();
	const chunks = [];
	const events = [];
	let writeCallbacks = 0;
	let ended = false;

	check(socket instanceof net.Socket, "Socket instance");
	check(socket instanceof stream.Duplex, "Duplex instance");
	check(socket.connecting === false, "initial connecting");
	check(socket.pending === true, "initial pending");
	check(socket.readyState === "open", "initial ready state");

	socket.on("connect", () => {
		events.push("connect");
		check(socket.connecting === false, "connected connecting");
		check(socket.pending === false, "connected pending");
		check(socket.readyState === "open", "connected ready state");
		check(socket.setNoDelay() === socket, "setNoDelay return");
		check(socket.setKeepAlive(true, 1000) === socket, "setKeepAlive return");
		const request =
			"POST /socket HTTP/1.1\r\n" +
			"Host: 127.0.0.1\r\n" +
			"Content-Length: 12\r\n" +
			"Connection: close\r\n\r\n" +
			"request-body";
		check(
			socket.write(Buffer.from(request), () => {
				writeCallbacks++;
				events.push("write");
			}) === true,
			"write return",
		);
	});
	socket.on("data", (chunk) => {
		check(Buffer.isBuffer(chunk), "data is Buffer");
		chunks.push(chunk);
		if (!ended) {
			ended = true;
			check(socket.end() === socket, "end return");
		}
	});
	socket.on("end", () => events.push("end"));
	socket.on("error", (error) => {
		console.log("FAIL: unexpected socket error " + error.message);
		failures++;
	});
	socket.on("close", (hadError) => {
		events.push("close");
		const response = Buffer.concat(chunks).toString("utf8");
		check(
			response.includes("HTTP/1.1 200 OK"),
			"response status: " + JSON.stringify(response),
		);
		check(
			response.endsWith("socket-response"),
			"response body: " + JSON.stringify(response),
		);
		check(writeCallbacks === 1, "write callback count");
		check(events[0] === "connect", "connect event first");
		check(events.includes("write"), "write callback event");
		check(events.includes("end"), "end event: " + events.join(","));
		check(events[events.length - 1] === "close", "close event last");
		check(hadError === false, "normal close hadError");
		check(socket.destroyed === true, "normal close destroyed");
		check(socket.readyState === "closed", "closed ready state");
		runLarge(port);
	});
	check(socket.connect(port, "127.0.0.1") === socket, "connect return");
});

function runLarge(port) {
	const socket = net.createConnection(port, "localhost");
	const chunks = [];
	let drained = 0;
	let writeCallbacks = 0;
	let dataEvents = 0;
	let resumed = false;
	socket.on("connect", () => {
		const header =
			"POST /large HTTP/1.1\r\n" +
			"Host: localhost\r\n" +
			"Content-Length: 400000\r\n" +
			"Connection: close\r\n\r\n";
		check(socket.write(header), "large header write return");
		check(
			socket.write(Buffer.alloc(400000, 0x61), () => writeCallbacks++) === false,
			"large body applies backpressure",
		);
	});
	socket.on("drain", () => drained++);
	socket.on("data", (chunk) => {
		dataEvents++;
		chunks.push(chunk);
		if (!resumed) {
			check(socket.pause() === socket, "pause return");
			setTimeout(() => {
				resumed = true;
				check(socket.resume() === socket, "resume return");
			}, 5);
		}
	});
	socket.on("error", (error) => {
		console.log("FAIL: unexpected large socket error " + error.message);
		failures++;
	});
	socket.on("close", (hadError) => {
		const response = Buffer.concat(chunks).toString("utf8");
		check(response.includes("HTTP/1.1 200 OK"), "large response status");
		check(response.endsWith("b".repeat(200000)), "large response body");
		check(writeCallbacks === 1, "large write callback count");
		check(drained === 1, "one low-water drain event");
		check(dataEvents > 1, "paused response resumes across read turns");
		check(resumed, "resume timer ran");
		check(hadError === false, "large close hadError");
		runCancellation(port);
	});
}

function runCancellation(port) {
	const expected = new Error("cancelled");
	const events = [];
	const socket = net.createConnection(port, "127.0.0.1");
	check(socket instanceof net.Socket, "createConnection return");
	socket.on("connect", () => check(false, "cancelled connect event"));
	socket.on("error", (error) => {
		check(error === expected, "cancellation error identity");
		events.push("error");
	});
	socket.on("close", (hadError) => {
		events.push("close");
		check(events.join(",") === "error,close", "cancellation event order");
		check(hadError === true, "cancellation hadError");
		server.close(() => runRefused(port));
	});
	check(socket.destroy(expected) === socket, "destroy return");
	check(socket.destroyed === true, "destroy immediate state");
}

function runRefused(port) {
	const events = [];
	const socket = net.connect(port, "127.0.0.1");
	socket.on("connect", () => check(false, "refused connect event"));
	socket.on("error", (error) => {
		check(error instanceof Error, "refused Error instance");
		check(error.code === "ECONNREFUSED", "refused error code");
		events.push("error");
	});
	socket.on("close", (hadError) => {
		events.push("close");
		check(events.join(",") === "error,close", "refused event order");
		check(hadError === true, "refused hadError");
		finish();
	});
}
