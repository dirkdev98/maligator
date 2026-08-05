"use strict";

const { AsyncLocalStorage } = require("node:async_hooks");
const http = require("node:http");

const storage = new AsyncLocalStorage();
let passed = 0;
let total = 0;
let completed = 0;

function check(condition, name) {
	total++;
	if (condition) passed++;
	else console.log("FAIL: " + name);
}

const server = http.createServer((request, response) => {
	check(storage.getStore() === "listen", "server request resource context");
	const id = request.url.slice(1);
	storage.run("server-" + id, () => {
		Promise.resolve().then(() => {
			check(storage.getStore() === "server-" + id, "server promise " + id);
		});
		response.write("response-", () => {
			check(storage.getStore() === "server-" + id, "response write " + id);
		});
		response.end(id, () => {
			check(storage.getStore() === "server-" + id, "response end " + id);
		});
	});
});

storage.run("listen", () => {
	server.listen(0, "127.0.0.1", () => {
		check(storage.getStore() === "listen", "listen callback context");
		const port = server.address().port;
		start("one", port);
		start("two", port);
	});
});

function start(id, port) {
	storage.run("client-" + id, () => {
		http.get({ hostname: "127.0.0.1", port, path: "/" + id }, (response) => {
			check(storage.getStore() === "client-" + id, "response callback " + id);
			let body = "";
			let dataContext = true;
			response.on("data", (chunk) => {
				dataContext = dataContext && storage.getStore() === "client-" + id;
				body += chunk.toString("utf8");
			});
			response.on("end", () => {
				check(storage.getStore() === "client-" + id, "response end " + id);
				check(dataContext, "response data " + id);
				check(body === "response-" + id, "response body " + id);
				if (++completed === 2) {
					const closeContext = storage.getStore();
					server.close(() => {
						check(
							storage.getStore() === closeContext,
							"close callback registration context",
						);
						console.log("RESULT " + passed + "/" + total);
					});
				}
			});
		});
	});
}
