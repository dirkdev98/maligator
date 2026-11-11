import http from "node:http";
import net from "node:net";

const results = [];
const log = (...values) => results.push(values.join(" "));
const big = Buffer.alloc(8 * 1024 * 1024, 97);
const handled = [];

const server = http.createServer((request, response) => {
	handled.push(request.url);
	if (request.url === "/big") {
		response.setHeader("Content-Length", big.length);
		response.end(big);
		return;
	}
	if (request.url === "/upload") {
		let received = 0;
		request.on("data", (chunk) => {
			received += chunk.length;
		});
		request.on("aborted", () => log("upload aborted", received > 0));
		request.on("close", () => log("upload closed", request.complete));
		return;
	}
	response.end(`ok ${request.url}`);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();

// A client that sends two pipelined requests and reads nothing for a while: the large
// first response fills the socket, and the follow-up waits behind it.
const stalled = await new Promise((resolve, reject) => {
	const socket = net.connect(port, "127.0.0.1", () => {
		socket.pause();
		socket.write(
			"GET /big HTTP/1.1\r\nHost: x\r\n\r\nGET /after HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
		);
		setTimeout(() => {
			log("handled while stalled", handled.includes("/big"));
			let bytes = 0;
			let text = "";
			socket.on("data", (chunk) => {
				bytes += chunk.length;
				text = (text + chunk.toString("latin1")).slice(-64);
			});
			socket.on("end", () =>
				resolve({ bytes, tail: text.slice(text.lastIndexOf("\r\n\r\n") + 4) }),
			);
			socket.resume();
		}, 200);
	});
	socket.on("error", reject);
});
log("stalled pipeline", stalled.bytes > big.length, stalled.tail);
log("handled after drain", handled.join(","));

// A peer that resets mid-body.
await new Promise((resolve) => {
	const socket = net.connect(port, "127.0.0.1", () => {
		socket.write(
			"POST /upload HTTP/1.1\r\nHost: x\r\nContent-Length: 1000000\r\n\r\n" +
				"b".repeat(100000),
		);
		setTimeout(() => {
			socket.resetAndDestroy();
			setTimeout(resolve, 100);
		}, 50);
	});
	socket.on("error", () => {});
});

// The server still answers afterwards.
const after = await new Promise((resolve) => {
	http.get({ host: "127.0.0.1", port, path: "/still", agent: false }, (response) => {
		let text = "";
		response.on("data", (chunk) => (text += chunk));
		response.on("end", () => resolve(`${response.statusCode} ${text}`));
	});
});
log("after reset", after);
await new Promise((resolve) => server.close(resolve));
console.log(results.join("\n"));
