"use strict";

/* oxlint-disable -- This compatibility fixture intentionally uses untyped CommonJS. */

const assert = require("node:assert/strict");
const http = require("node:http");
const { listen } = require("./app.js");

function request(origin, path, options = {}) {
	const body = options.body || "";
	const headers = { ...options.headers };
	if (body) headers["content-length"] = Buffer.byteLength(body);

	return new Promise((resolve, reject) => {
		const outgoing = http.request(
			`${origin}${path}`,
			{ method: options.method || "GET", headers },
			(response) => {
				const chunks = [];
				response.on("data", (chunk) => chunks.push(chunk));
				response.on("end", () => {
					const text = Buffer.concat(chunks).toString("utf8");
					resolve({
						body: response.headers["content-type"]?.startsWith("application/json")
							? JSON.parse(text)
							: text,
						headers: response.headers,
						status: response.statusCode,
					});
				});
			},
		);
		outgoing.on("error", reject);
		outgoing.end(body);
	});
}

async function main() {
	const { origin, close } = await listen();
	try {
		const route = await request(origin, "/users/a%20b?search=teeth&tag=one&tag=two");
		assert.equal(route.status, 200);
		assert.deepEqual(route.body, {
			id: "a b",
			query: { search: "teeth", tag: ["one", "two"] },
		});

		const middleware = await request(origin, "/middleware");
		assert.deepEqual(middleware.body, {
			order: ["application", "route", "async", "handler"],
		});

		const json = await request(origin, "/json", {
			body: JSON.stringify({ enabled: true, count: 2 }),
			headers: { "content-type": "application/json" },
			method: "POST",
		});
		assert.equal(json.status, 201);
		assert.deepEqual(json.body, { body: { enabled: true, count: 2 } });

		const form = await request(origin, "/form", {
			body: "name=Maligator&role=runtime",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			method: "POST",
		});
		assert.deepEqual(form.body, { body: { name: "Maligator", role: "runtime" } });

		const redirect = await request(origin, "/cookie");
		assert.equal(redirect.status, 302);
		assert.equal(redirect.headers.location, "/redirect-target");
		assert.match(redirect.headers["set-cookie"][0], /^wave=zero;/);
		assert.match(redirect.headers["set-cookie"][0], /HttpOnly/);
		assert.match(redirect.headers["set-cookie"][0], /SameSite=Lax/);

		const redirected = await request(origin, redirect.headers.location);
		assert.equal(redirected.status, 200);
		assert.equal(redirected.body, "redirected");

		const staticFile = await request(origin, "/assets/hello.txt");
		assert.equal(staticFile.status, 200);
		assert.equal(staticFile.body, "static payload\n");
		assert.match(staticFile.headers["content-type"], /^text\/plain/);
		assert.equal(staticFile.headers["content-length"], "15");
		assert.match(staticFile.headers.etag, /^W\/"f-[0-9a-f]+"$/);
		assert.match(staticFile.headers["last-modified"], / GMT$/);

		const staticHead = await request(origin, "/assets/hello.txt", { method: "HEAD" });
		assert.equal(staticHead.status, 200);
		assert.equal(staticHead.body, "");
		assert.equal(staticHead.headers["content-length"], "15");
		assert.equal(staticHead.headers.etag, staticFile.headers.etag);

		const notModified = await request(origin, "/assets/hello.txt", {
			headers: { "if-none-match": staticFile.headers.etag },
		});
		assert.equal(notModified.status, 304);
		assert.equal(notModified.body, "");

		const range = await request(origin, "/assets/hello.txt", {
			headers: { range: "bytes=7-13" },
		});
		assert.equal(range.status, 206);
		assert.equal(range.body, "payload");
		assert.equal(range.headers["content-range"], "bytes 7-13/15");
		assert.equal(range.headers["content-length"], "7");

		const unsatisfiable = await request(origin, "/assets/hello.txt", {
			headers: { range: "bytes=99-100" },
		});
		assert.equal(unsatisfiable.status, 416);
		assert.equal(unsatisfiable.headers["content-range"], "bytes */15");

		const staticRedirect = await request(origin, "/assets");
		assert.equal(staticRedirect.status, 301);
		assert.equal(staticRedirect.headers.location, "/assets/");

		const staticIndex = await request(origin, "/assets/");
		assert.equal(staticIndex.status, 200);
		assert.match(staticIndex.body, /<h1>Maligator static<\/h1>/);

		const hidden = await request(origin, "/assets/.secret");
		assert.equal(hidden.status, 404);
		assert.deepEqual(hidden.body, { error: "Not found: GET /assets/.secret" });

		const missing = await request(origin, "/missing");
		assert.equal(missing.status, 404);
		assert.deepEqual(missing.body, { error: "Not found: GET /missing" });

		const rejected = await request(origin, "/async-error");
		assert.equal(rejected.status, 500);
		assert.deepEqual(rejected.body, { error: "wave-0 async rejection" });
	} finally {
		await close();
	}
}

main().then(
	() => console.log("Express 5 fixture smoke check passed"),
	(error) => {
		console.error(error);
		process.exitCode = 1;
	},
);
