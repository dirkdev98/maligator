"use strict";

/* eslint-disable -- This real-world compatibility fixture intentionally uses CommonJS. */

const assert = require("node:assert/strict");
const { listen } = require("./assets-app.cjs");

async function main() {
	const { origin, close } = await listen();
	try {
		const health = await fetch(`${origin}/api/health`);
		assert.equal(health.status, 200);
		assert.deepEqual(await health.json(), {
			assets: "mal",
			service: "express-assets",
		});

		const echo = await fetch(`${origin}/api/echo`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ count: 2, source: "real-world" }),
		});
		assert.equal(echo.status, 201);
		assert.deepEqual(await echo.json(), {
			body: { count: 2, source: "real-world" },
		});

		const asset = await fetch(`${origin}/assets/hello.txt`);
		assert.equal(asset.status, 200);
		assert.match(asset.headers.get("content-type"), /^text\/plain/);
		const body = await asset.text();
		assert.match(body, /^static payload/);

		const range = await fetch(`${origin}/assets/hello.txt`, {
			headers: { range: "bytes=7-13" },
		});
		assert.equal(range.status, 206);
		assert.equal(await range.text(), "payload");

		console.log(`EXPRESS_ASSETS_SMOKE ${body.trim()}`);
	} finally {
		await close();
	}
}

async function serve() {
	const { origin } = await listen();
	console.log(`EXPRESS_ASSETS_READY ${origin}`);
}

(process.argv.includes("--serve") ? serve() : main()).then(
	() => {},
	(error) => {
		console.error(error.stack || error.message || String(error));
		process.exit(1);
	},
);
