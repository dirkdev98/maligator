import http from "node:http";
import net from "node:net";

const results = [];
const log = (...values) => results.push(values.join(" "));

function listen(server) {
	return new Promise((resolve) =>
		server.listen(0, "127.0.0.1", () => resolve(server.address().port)),
	);
}

function close(server) {
	return new Promise((resolve) => server.close(resolve));
}

// Sends a raw request and resolves with the response's status line and body.
function raw(port, head) {
	return new Promise((resolve, reject) => {
		const socket = net.connect(port, "127.0.0.1", () => socket.write(head));
		let data = "";
		socket.setEncoding("latin1");
		socket.on("data", (chunk) => {
			data += chunk;
		});
		socket.on("end", () => {
			const split = data.indexOf("\r\n\r\n");
			resolve({
				status: data.slice(0, data.indexOf("\r\n")),
				body: data.slice(split + 4),
			});
		});
		socket.on("error", reject);
	});
}

function head(fields) {
	return `GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n${fields}\r\n`;
}

function describeRequest(request, response) {
	response.setHeader("Connection", "close");
	response.end(
		[
			request.rawHeaders.length / 2,
			Object.keys(request.headers).length,
			request.headers["x-dup"] ?? "-",
			(request.headers["x-pad"] ?? "").length,
		].join(","),
	);
}

const server = http.createServer(describeRequest);
log("defaults", http.maxHeaderSize, server.maxHeaderSize, server.maxHeadersCount);
const port = await listen(server);
let response = await raw(port, head(`X-Pad: ${"v".repeat(16000)}\r\n`));
log("under budget", response.status, response.body);
response = await raw(port, head(`X-Pad: ${"v".repeat(16384)}\r\n`));
log("over budget", response.status.split(" ").slice(0, 2).join(" "));
let fields = "";
for (let index = 0; index < 600; index++) fields += `X-F${index}: v\r\n`;
fields += "X-Dup: a\r\nX-Dup: b\r\nx-dup: c\r\n";
response = await raw(port, head(fields));
log("many fields", response.status, response.body);
// Host and Connection make two of the pairs.
response = await raw(port, head("a: b\r\n".repeat(998)));
log("count limit", response.status, response.body);
response = await raw(port, head("a: b\r\n".repeat(999)));
log("count overflow", response.status.split(" ").slice(0, 2).join(" "));
await close(server);

const unlimited = http.createServer(describeRequest);
unlimited.maxHeadersCount = 0;
const unlimitedPort = await listen(unlimited);
response = await raw(unlimitedPort, head("X-Dup: b\r\n".repeat(1500)));
log("unlimited duplicates", response.status, response.body.length);
fields = "";
for (let index = 0; index < 1500; index++) fields += `h${index}: v\r\n`;
response = await raw(unlimitedPort, head(fields));
log("unlimited distinct", response.status, response.body);
await close(unlimited);

const wide = http.createServer({ maxHeaderSize: 65536 }, describeRequest);
wide.maxHeadersCount = 30;
log("raised", wide.maxHeaderSize, wide.maxHeadersCount);
const widePort = await listen(wide);
fields = `X-Pad: ${"v".repeat(40000)}\r\n`;
for (let index = 0; index < 20; index++) fields += `X-F${index}: v\r\n`;
response = await raw(widePort, head(fields));
log("raised budget", response.status, response.body);
response = await raw(widePort, head("a: b\r\n".repeat(29)));
log("raised count", response.status.split(" ").slice(0, 2).join(" "));
await close(wide);

let originHead = `X-Big: ${"a".repeat(20000)}\r\n`;
const origin = net.createServer((socket) => {
	socket.once("data", () =>
		socket.end(
			`HTTP/1.1 200 OK\r\n${originHead}Content-Length: 2\r\nConnection: close\r\n\r\nok`,
		),
	);
});
const originPort = await listen(origin);
function get(options) {
	return new Promise((resolve) => {
		const request = http.get(
			{ host: "127.0.0.1", port: originPort, agent: false, ...options },
			(incoming) => {
				let text = "";
				incoming.setEncoding("utf8");
				incoming.on("data", (chunk) => {
					text += chunk;
				});
				incoming.on("end", () =>
					resolve(
						`${incoming.statusCode} ${incoming.rawHeaders.length / 2} ${(incoming.headers["x-big"] ?? "").length} ${text}`,
					),
				);
			},
		);
		request.on("error", (error) => resolve(`${error.code} ${error.message}`));
	});
}
log("client default", await get({}));
log("client raised", await get({ maxHeaderSize: 65536 }));
originHead = "a: b\r\n".repeat(1200);
log("client pairs", await get({}));
await close(origin);

for (const value of [-1, 1.5, "16384"]) {
	try {
		http.createServer({ maxHeaderSize: value });
		log("server option", JSON.stringify(value), "accepted");
	} catch (error) {
		log("server option", JSON.stringify(value), error.name);
	}
	try {
		http.request({ host: "127.0.0.1", port: 1, maxHeaderSize: value }).destroy();
		log("request option", JSON.stringify(value), "accepted");
	} catch (error) {
		log("request option", JSON.stringify(value), error.name);
	}
}
console.log(results.join("\n"));
