"use strict";

/* eslint-disable -- This compatibility fixture intentionally uses untyped CommonJS. */

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
