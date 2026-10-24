const EventEmitter = require("node:events");
const http = require("node:http");
const net = require("node:net");

// Two peers that answer with a per-connection id, so requests can tell a reused
// connection without printing ports.
const port = Number(process.env.MAL_HTTP_FAILURES_PORT);
const poolPort = Number(process.env.MAL_HTTP_FAILURES_POOL_PORT);

function describe(error, peerPort) {
	return JSON.stringify({
		name: error.name,
		message:
			peerPort === undefined
				? error.message
				: error.message.replace(String(peerPort), "PORT"),
		code: error.code,
		errno: error.errno,
		syscall: error.syscall,
		address: error.address,
		port: error.port === undefined ? undefined : error.port === peerPort,
		hostname: error.hostname,
		keys: Object.keys(error).join(","),
	});
}

function cutResponse(path, listenOnResponse) {
	return new Promise((resolve) => {
		const events = [];
		const request = http.get(
			{ hostname: "127.0.0.1", port, path, agent: false },
			(response) => {
				response.on("data", (chunk) => events.push(`response:data:${chunk.length}`));
				response.on("aborted", () => {
					events.push(`response:aborted:${response.aborted}:${response.complete}`);
				});
				if (listenOnResponse)
					response.on("error", (error) =>
						events.push(`response:error:${describe(error)}`),
					);
				response.on("close", () => events.push(`response:close:${response.destroyed}`));
			},
		);
		request.on("error", (error) => events.push(`request:error:${describe(error)}`));
		request.on("close", () => {
			events.push("request:close");
			setTimeout(
				() => resolve(`cut ${path} ${listenOnResponse}: ${events.join(" | ")}`),
				30,
			);
		});
	});
}

function destroyResponse(error, listenOnResponse) {
	return new Promise((resolve) => {
		const events = [];
		const request = http.get(
			{ hostname: "127.0.0.1", port, path: "/partial", agent: false },
			(response) => {
				if (listenOnResponse)
					response.on("error", (cause) =>
						events.push(`response:error:${cause === error}`),
					);
				response.on("aborted", () => events.push("response:aborted"));
				response.on("close", () => events.push("response:close"));
				response.destroy(error);
				events.push("destroyed");
			},
		);
		request.on("error", (cause) => events.push(`request:error:${cause === error}`));
		request.on("close", () => {
			events.push("request:close");
			setTimeout(
				() =>
					resolve(
						`destroy ${error !== undefined} ${listenOnResponse}: ${events.join(" | ")}`,
					),
				30,
			);
		});
	});
}

async function refused() {
	const closed = net.createServer();
	await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
	const closedPort = closed.address().port;
	await new Promise((resolve) => closed.close(resolve));
	return new Promise((resolve) => {
		const events = [];
		const request = http.request({
			hostname: "127.0.0.1",
			port: closedPort,
			method: "POST",
			agent: false,
		});
		request.on("error", (error) => events.push(`error:${describe(error, closedPort)}`));
		request.on("close", () => {
			events.push(`close:${request.writableFinished}:${request.writableEnded}`);
			setTimeout(() => resolve(`refused: ${events.join(" | ")}`), 30);
		});
		request.write("body", (error) => events.push(`write:${error?.code}`));
		request.end("tail", (error) => events.push(`end:${error?.code}`));
	});
}

function unresolvable() {
	return new Promise((resolve) => {
		const request = http.get({ hostname: "nonexistent.invalid", port: 80, agent: false });
		request.on("error", (error) => resolve(`unresolvable: ${describe(error)}`));
	});
}

let previousConnection = "";
function pooled(label, peerPort, agent) {
	return new Promise((resolve) => {
		const options = { hostname: "127.0.0.1", port: peerPort, path: "/" };
		if (agent !== undefined) options.agent = agent;
		const request = http.get(options, (response) => {
			let body = "";
			response.setEncoding("utf8");
			response.on("data", (chunk) => (body += chunk));
			response.on("end", () => {
				const [connection, header] = body.split(":");
				const same = connection === previousConnection;
				previousConnection = connection;
				// Node's agent pools the socket only after the 'end' listeners return.
				setImmediate(() =>
					resolve(
						`${label}: reused=${request.reusedSocket} same=${same} connection=${header}`,
					),
				);
			});
		});
	});
}

function agentShape(agent) {
	const shape = {};
	for (const key of Object.keys(agent)) {
		if (key.startsWith("_")) continue;
		const value = agent[key];
		shape[key] =
			typeof value === "object" && value !== null
				? `${Object.getPrototypeOf(value) === null ? "null-proto" : "object"}:${JSON.stringify(value)}`
				: String(value);
	}
	return JSON.stringify(shape);
}

function constructionError(options) {
	try {
		new http.Agent(options);
		return "none";
	} catch (error) {
		return `${error.name}:${error.code}:${error.message}`;
	}
}

(async () => {
	const lines = [];
	for (const path of ["/truncate-fin", "/truncate-rst"]) {
		for (const listen of [false, true]) lines.push(await cutResponse(path, listen));
	}
	lines.push(await destroyResponse(new Error("stop"), true));
	lines.push(await destroyResponse(new Error("stop"), false));
	lines.push(await destroyResponse(undefined, true));
	lines.push(await refused());
	lines.push(await unresolvable());

	lines.push(await pooled("default first", port));
	lines.push(await pooled("default second", port));
	lines.push(await pooled("agent false", port, false));
	lines.push(await pooled("agent false again", port, false));
	lines.push(await pooled("plain agent", port, new http.Agent()));
	const keepAlive = new http.Agent({ keepAlive: true });
	lines.push(await pooled("keep-alive agent first", poolPort, keepAlive));
	lines.push(await pooled("keep-alive agent second", poolPort, keepAlive));
	lines.push(await pooled("global agent", port, http.globalAgent));

	lines.push(`agent: ${agentShape(new http.Agent({ keepAlive: true }))}`);
	lines.push(
		`plain agent: ${agentShape(new http.Agent({ maxSockets: 4, scheduling: "fifo" }))}`,
	);
	lines.push(
		`global agent: keepAlive=${http.globalAgent.keepAlive} options=${JSON.stringify(http.globalAgent.options)}`,
	);
	lines.push(
		`agent emitter: ${keepAlive instanceof EventEmitter} ${Object.getPrototypeOf(http.Agent) === EventEmitter}`,
	);
	lines.push(`agent scheduling: ${constructionError({ scheduling: "random" })}`);
	lines.push(`agent maxTotalSockets: ${constructionError({ maxTotalSockets: 0 })}`);
	lines.push(
		`agent maxTotalSockets type: ${constructionError({ maxTotalSockets: "4" })}`,
	);
	console.log(lines.join("\n"));
	http.globalAgent.destroy();
	keepAlive.destroy();
})();
