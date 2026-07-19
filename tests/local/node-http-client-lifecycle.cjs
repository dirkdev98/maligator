const http = require("node:http");

let failures = 0;

function check(condition, name) {
	if (!condition) {
		failures++;
		console.log("FAIL: " + name);
	}
}

function finish() {
	if (failures !== 0) throw new Error("HTTP client lifecycle failures: " + failures);
	console.log("HTTP CLIENT LIFECYCLE PASS");
}

let abortRequest;
let destroyRequest;
const destroyError = new Error("destroy requested");

const server = http.createServer((request, response) => {
	if (request.url === "/abort") {
		check(abortRequest.abort() === undefined, "abort return value");
		abortRequest.abort();
		check(abortRequest.destroyed, "abort marks destroyed immediately");
		check(abortRequest.aborted, "abort marks aborted immediately");
		response.end("suppressed abort response");
		return;
	}
	if (request.url === "/destroy") {
		check(
			destroyRequest.destroy(destroyError) === destroyRequest,
			"destroy return value",
		);
		destroyRequest.destroy(new Error("ignored repeat"));
		check(destroyRequest.destroyed, "destroy marks destroyed immediately");
		check(!destroyRequest.aborted, "destroy does not mark aborted");
		response.end("suppressed destroy response");
		return;
	}
	if (request.url === "/normal") {
		response.end("normal response");
		return;
	}
	response.statusCode = 404;
	response.end("unexpected");
});

server.listen(0, "127.0.0.1", () => {
	const port = server.address().port;
	const preStartError = new Error("pre-start destroy");
	const events = [];
	const request = http.request(`http://127.0.0.1:${port}/never-started`);
	request.on("response", () => check(false, "pre-start response suppressed"));
	request.on("error", (error) => {
		check(error === preStartError, "pre-start destroy error identity");
		events.push("error");
	});
	request.on("close", () => {
		events.push("close");
		check(events.join(",") === "error,close", "pre-start terminal event order");
		check(request.destroyed, "pre-start destroyed state");
		check(!request.aborted, "pre-start aborted state");
		runAbort(port);
	});
	check(request.destroy(preStartError) === request, "pre-start destroy return value");
	request.destroy(new Error("ignored repeat"));
	check(request.destroyed, "pre-start destroy is immediate");
	check(!request.writableEnded, "pre-start writableEnded is initially false");
	check(!request.writableFinished, "pre-start writableFinished is initially false");
	check(request.write("ignored") === false, "write after destroy is ignored");
	check(request.end() === request, "end after destroy returns request");
});

function runAbort(port) {
	const events = [];
	abortRequest = http.request(`http://127.0.0.1:${port}/abort`);
	abortRequest.on("finish", () => {
		check(abortRequest.writableFinished, "finish marks writableFinished");
		events.push("finish");
	});
	abortRequest.on("abort", () => events.push("abort"));
	abortRequest.on("error", (error) => {
		check(error.code === "ECONNRESET", "abort reset error code");
		events.push("error");
	});
	abortRequest.on("response", () => check(false, "abort suppresses response"));
	abortRequest.on("close", () => {
		events.push("close");
		check(events.join(",") === "finish,abort,error,close", "abort terminal event order");
		check(abortRequest.writableEnded, "abort writableEnded after end");
		check(abortRequest.writableFinished, "abort writableFinished after finish");
		runDestroy(port);
	});
	abortRequest.end();
}

function runDestroy(port) {
	const events = [];
	destroyRequest = http.request(`http://127.0.0.1:${port}/destroy`);
	destroyRequest.on("finish", () => events.push("finish"));
	destroyRequest.on("error", (error) => {
		check(error === destroyError, "active destroy error identity");
		events.push("error");
	});
	destroyRequest.on("response", () => check(false, "destroy suppresses response"));
	destroyRequest.on("close", () => {
		events.push("close");
		check(events.join(",") === "finish,error,close", "destroy terminal event order");
		runNormal(port);
	});
	destroyRequest.end();
}

function runNormal(port) {
	let responseEnded = false;
	let requestClosed = false;
	const chunks = [];
	const request = http.request(`http://127.0.0.1:${port}/normal`, (response) => {
		response.on("data", (chunk) => chunks.push(chunk));
		response.on("end", () => {
			responseEnded = true;
			check(Buffer.concat(chunks).toString("utf8") === "normal response", "normal body");
			maybeCloseServer();
		});
	});
	request.on("error", () => check(false, "normal request error"));
	request.on("close", () => {
		requestClosed = true;
		check(request.destroyed, "normal completion marks destroyed");
		check(request.writableFinished, "normal completion stays writableFinished");
		maybeCloseServer();
	});
	request.end();

	function maybeCloseServer() {
		if (!responseEnded || !requestClosed) return;
		server.close(() => runRefused(port));
	}
}

function runRefused(port) {
	const events = [];
	const request = http.request(`http://127.0.0.1:${port}/closed`);
	request.on("response", () => check(false, "refused response"));
	request.on("error", (error) => {
		check(error instanceof Error, "refused error object");
		events.push("error");
	});
	request.on("close", () => {
		events.push("close");
		check(events.join(",") === "error,close", "refused terminal event order");
		check(request.destroyed, "refused request destroyed");
		check(request.writableFinished, "refused write side finished");
		finish();
	});
	request.end();
}
