"use strict";

/* eslint-disable -- This real-world compatibility fixture intentionally uses CommonJS. */

const express = require("express");

const app = express();
app.disable("x-powered-by");
app.use(express.json());

app.get("/api/health", (_request, response) => {
	response.json({ assets: "mal", service: "express-assets" });
});

app.post("/api/echo", (request, response) => {
	response.status(201).json({ body: request.body });
});

const publicDirectory = globalThis.mal.assets.materialize("public");
app.use("/assets", express.static(publicDirectory));

app.use((request, response) => {
	response.status(404).json({ error: `Not found: ${request.method} ${request.path}` });
});

function listen(port = 0, host = "127.0.0.1") {
	return new Promise((resolve, reject) => {
		const server = app.listen(port, host);
		server.once("error", reject);
		server.once("listening", () => {
			server.removeListener("error", reject);
			const address = server.address();
			if (!address || typeof address === "string") {
				reject(new Error("Expected a TCP server address"));
				return;
			}
			resolve({
				origin: `http://${host}:${address.port}`,
				close: () =>
					new Promise((closeResolve, closeReject) => {
						server.close((error) => {
							if (error) closeReject(error);
							else closeResolve();
						});
					}),
			});
		});
	});
}

module.exports = { app, listen, publicDirectory };
