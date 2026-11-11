import http from "node:http";
import net from "node:net";

const collect = globalThis.__mal_collect_garbage ?? globalThis.gc;
const fields = [
	"123: numeric",
	"X-Fresh-Name: first",
	"x-fresh-name: second",
	"Cookie: a=1",
	"cookie: b=2",
	"Set-Cookie: one=1",
	"set-cookie: two=2",
	"User-Agent: first-agent",
	"user-agent: second-agent",
];
function snapshot(headers, rawHeaders) {
	collect?.();
	const keys = Object.keys(headers);
	const values = keys.map((key) => [key, headers[key]]);
	const descriptor = Object.getOwnPropertyDescriptor(headers, "x-fresh-name");
	delete headers["x-fresh-name"];
	Object.freeze(headers);
	collect?.();
	return {
		keys,
		values,
		rawHeaders,
		descriptor,
		deleted: !("x-fresh-name" in headers),
		frozen: Object.isFrozen(headers),
		cookies: headers["set-cookie"],
	};
}
async function protocol() {
	let retained;
	const server = http.createServer((request, response) => {
		retained = request.headers;
		response.end(JSON.stringify(snapshot(request.headers, request.rawHeaders)));
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const received = await new Promise((resolve, reject) => {
		let text = "";
		const socket = net.createConnection(
			{ host: "127.0.0.1", port: server.address().port },
			() => {
				socket.end(
					[
						"GET / HTTP/1.1",
						"Host: localhost",
						...fields,
						"Connection: close",
						"",
						"",
					].join("\r\n"),
				);
			},
		);
		socket.on("data", (data) => {
			text += data.toString();
		});
		socket.on("end", () => resolve(text.slice(text.indexOf("\r\n\r\n") + 4)));
		socket.on("error", reject);
	});
	await new Promise((resolve) => server.close(resolve));
	collect?.();
	console.log("request", received);
	console.log("retained", JSON.stringify(retained["set-cookie"]));
	const peer = net.createServer((socket) => {
		socket.once("data", () =>
			socket.end(
				[
					"HTTP/1.1 200 OK",
					...fields,
					"Content-Length: 2",
					"Connection: close",
					"",
					"ok",
				].join("\r\n"),
			),
		);
	});
	await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
	const response = await new Promise((resolve, reject) => {
		http
			.get(`http://127.0.0.1:${peer.address().port}/`, (incoming) => {
				incoming.resume();
				incoming.on("end", () =>
					resolve(snapshot(incoming.headers, incoming.rawHeaders)),
				);
			})
			.on("error", reject);
	});
	await new Promise((resolve) => peer.close(resolve));
	console.log("response", JSON.stringify(response));
}
if (process.env.HEADER_MEMORY_SERVER === "1") {
	if (typeof collect !== "function") throw new Error("collection capability missing");
	const server = http.createServer((request, response) => {
		if (request.url === "/memory") {
			for (let i = 0; i < 3; i++) collect();
			response.end(JSON.stringify(process.memoryUsage()));
		} else response.end("ok");
	});
	server.listen(0, "127.0.0.1", () => console.log(`PORT ${server.address().port}`));
} else await protocol();
