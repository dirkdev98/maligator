"use strict";

/* oxlint-disable -- This compatibility fixture intentionally uses untyped CommonJS. */

const express = require("express");

const app = express();
let benchmarkClose = null;

app.disable("x-powered-by");
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use((request, _response, next) => {
	request.middlewareOrder = ["application"];
	next();
});

app.param("id", (request, _response, next, id) => {
	request.resolvedId = id;
	next();
});

app.get("/users/:id", (request, response) => {
	response.json({ id: request.resolvedId, query: request.query });
});

app.get(
	"/middleware",
	(request, _response, next) => {
		request.middlewareOrder.push("route");
		next();
	},
	async (request, _response, next) => {
		await Promise.resolve();
		request.middlewareOrder.push("async");
		next();
	},
	(request, response) => {
		request.middlewareOrder.push("handler");
		response.json({ order: request.middlewareOrder });
	},
);

app.get("/async-error", async () => {
	await Promise.resolve();
	throw new Error("wave-0 async rejection");
});

app.post("/json", (request, response) => {
	response.status(201).json({ body: request.body });
});

app.post("/form", (request, response) => {
	response.json({ body: request.body });
});

app.get("/cookie", (_request, response) => {
	response.cookie("wave", "zero", { httpOnly: true, sameSite: "lax" });
	response.redirect(302, "/redirect-target");
});

app.get("/redirect-target", (_request, response) => {
	response.send("redirected");
});

app.use("/assets", express.static(`${__dirname}/public`));

if (process.env.MAL_BENCH_CONTROL === "1") {
	if (typeof globalThis.__mal_reset_perf_stats === "function") {
		app.post("/__maligator_perf_reset", (_request, response) => {
			globalThis.__mal_reset_perf_stats();
			response.end();
		});
	}
	app.post("/__maligator_bench_exit", (_request, response) => {
		response.end();
		benchmarkClose();
	});
}

app.use((request, _response, next) => {
	const error = new Error(`Not found: ${request.method} ${request.path}`);
	error.status = 404;
	next(error);
});

app.use((error, _request, response, _next) => {
	response.status(error.status || 500).json({ error: error.message });
});

function listen(port = 0, host = "127.0.0.1") {
	return new Promise((resolve, reject) => {
		const server = app.listen(port, host);
		server.once("error", reject);
		server.once("listening", () => {
			server.removeListener("error", reject);
			if (process.env.MAL_BENCH_CONTROL === "1") {
				benchmarkClose = () => server.close();
			}
			const address = server.address();
			if (!address || typeof address === "string") {
				reject(new Error("Expected a TCP server address"));
				return;
			}

			resolve({
				origin: `http://${host}:${address.port}`,
				server,
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

if (require.main === module) {
	listen(Number(process.env.PORT) || 0)
		.then(({ origin, close }) => {
			console.log(`Express 5 fixture listening on ${origin}`);
			let closing = false;
			const shutdown = () => {
				if (closing) return;
				closing = true;
				close().then(
					() => process.exit(0),
					(error) => {
						console.error(error);
						process.exit(1);
					},
				);
			};

			process.once("SIGINT", shutdown);
			process.once("SIGTERM", shutdown);
		})
		.catch((error) => {
			console.error(error);
			process.exitCode = 1;
		});
}

module.exports = { app, listen };
