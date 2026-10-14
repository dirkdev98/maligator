"use strict";
const { app } = require("../../tests/fixtures/express-5/app.js");
const { Readable } = require("node:stream");
const cases = [
	{
		method: "GET",
		url: "/users/a%20b?search=teeth&tag=one&tag=two",
		status: 200,
		body: '{"id":"a b","query":{"search":"teeth","tag":["one","two"]}}',
	},
	{
		method: "GET",
		url: "/middleware",
		status: 200,
		body: '{"order":["application","route","async","handler"]}',
	},
	{
		method: "GET",
		url: "/cookie",
		status: 302,
		body: "Found. Redirecting to /redirect-target",
	},
	{ method: "GET", url: "/redirect-target", status: 200, body: "redirected" },
	{
		method: "GET",
		url: "/missing",
		status: 404,
		body: '{"error":"Not found: GET /missing"}',
	},
	{
		method: "GET",
		url: "/async-error",
		status: 500,
		body: '{"error":"wave-0 async rejection"}',
	},
	{
		method: "POST",
		url: "/json",
		status: 201,
		input: '{"enabled":true,"count":2}',
		type: "application/json",
		parsed: { enabled: true, count: 2 },
		body: '{"body":{"enabled":true,"count":2}}',
	},
	{
		method: "POST",
		url: "/form",
		status: 200,
		input: "name=Maligator&role=runtime",
		type: "application/x-www-form-urlencoded",
		parsed: { name: "Maligator", role: "runtime" },
		body: '{"body":{"name":"Maligator","role":"runtime"}}',
	},
];
const mix = [0, 1, 2, 3, 4, 5, 6, 6, 7, 7];
const mode = process.env.EXPRESS_IN_PROCESS_MODE || "parsed";
const requestCount = Number(process.env.EXPRESS_REQUESTS || 20000);
const durationMs = Number(process.env.EXPRESS_DURATION_MS || 0);
const control = process.env.EXPRESS_ADAPTER_CONTROL === "1";
if (
	!["parsed", "raw"].includes(mode) ||
	!Number.isSafeInteger(requestCount) ||
	requestCount < 1 ||
	!Number.isFinite(durationMs) ||
	durationMs < 0
)
	throw new Error("Invalid in-process Express benchmark configuration");
const oracles = [];
function requestFor(test) {
	const raw = mode === "raw" && test.input !== undefined;
	// Express reparents requests to IncomingMessage; own hooks keep the body stream in memory.
	const request = raw
		? new Readable({
				read() {
					this.push(test.input);
					this.push(null);
				},
				destroy(error, callback) {
					callback(error);
				},
			})
		: {};
	request.method = test.method;
	request.url = test.url;
	request.headers = raw
		? {
				"content-type": test.type,
				"content-length": String(Buffer.byteLength(test.input)),
			}
		: {};
	request.httpVersionMajor = 1;
	request.httpVersionMinor = 1;
	request.complete = false;
	request.socket = {
		readable: true,
		writable: true,
		remoteAddress: "127.0.0.1",
		encrypted: false,
	};
	request.connection = request.socket;
	if (!raw) request.body = test.parsed;
	return request;
}
function dispatch(test, check) {
	const request = requestFor(test);
	const headers = Object.create(null);
	let completion;
	let failure;
	let resolve;
	let reject;
	function fail(error) {
		failure = error;
		if (reject) reject(error);
	}
	const response = {
		statusCode: 200,
		headersSent: false,
		finished: false,
		setHeader(name, value) {
			headers[name.toLowerCase()] = value;
			return this;
		},
		getHeader(name) {
			return headers[name.toLowerCase()];
		},
		removeHeader(name) {
			delete headers[name.toLowerCase()];
		},
		end(chunk) {
			this.headersSent = true;
			this.finished = true;
			const body = chunk === undefined ? "" : String(chunk);
			if (this.statusCode !== test.status || body !== test.body) {
				fail(new Error(JSON.stringify({ url: test.url, status: this.statusCode, body })));
				return this;
			}
			if (
				check &&
				test.url === "/cookie" &&
				(headers.location !== "/redirect-target" ||
					!String(headers["set-cookie"]).includes("wave=zero"))
			) {
				fail(new Error("Cookie/redirect headers differ"));
				return this;
			}
			if (check) oracles.push({ url: test.url, status: this.statusCode, body, headers });
			completion = this.statusCode + body.length;
			if (resolve) resolve(completion);
			return this;
		},
	};
	if (control) {
		response.statusCode = test.status;
		if (test.url === "/cookie") {
			response.setHeader("Location", "/redirect-target");
			response.setHeader("Set-Cookie", "wave=zero");
		}
		if (mode === "raw" && test.input !== undefined) {
			request.on("data", () => {});
			request.once("end", () => response.end(test.body));
		} else response.end(test.body);
	} else {
		app.handle(request, response, (error) =>
			fail(error || new Error("Express did not respond")),
		);
	}
	if (failure) throw failure;
	if (completion !== undefined) return completion;
	return new Promise((onResolve, onReject) => {
		resolve = onResolve;
		reject = onReject;
	});
}
async function main() {
	let checksum = 0;
	for (const test of cases) await dispatch(test, true);
	for (let i = 0; i < 10000; i++) {
		const result = dispatch(cases[mix[i % mix.length]], false);
		if (typeof result !== "number") await result;
	}
	const start = performance.now();
	let completed = 0;
	while (
		completed < requestCount ||
		(durationMs > 0 && performance.now() - start < durationMs)
	) {
		const result = dispatch(cases[mix[completed % mix.length]], false);
		checksum += typeof result === "number" ? result : await result;
		completed++;
	}
	const elapsedMs = performance.now() - start;
	console.log(
		JSON.stringify({
			mode,
			control,
			completed,
			checksum,
			oracles,
			elapsedMs,
			requestsPerSecond: (completed * 1000) / elapsedMs,
		}),
	);
}
main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
