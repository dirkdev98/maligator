import http from "node:http";
import net from "node:net";

const results = [];
const log = (...values) => results.push(values.join(" "));

const server = http.createServer((request, response) => {
	let body = "";
	request.setEncoding("utf8");
	request.on("data", (chunk) => {
		body += chunk;
	});
	request.on("end", () => {
		const reply = () => response.end(`${request.method} ${request.url} ${body}`);
		if (request.url === "/slow") setTimeout(reply, 30);
		else reply();
	});
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();

// Sends raw bytes in one write and resolves with every response status and body.
function exchange(wire) {
	return new Promise((resolve, reject) => {
		const socket = net.connect(port, "127.0.0.1", () => socket.write(wire));
		let data = "";
		socket.setEncoding("latin1");
		socket.on("data", (chunk) => {
			data += chunk;
		});
		socket.on("error", reject);
		socket.on("close", () => {
			const responses = [];
			let rest = data;
			while (rest.length > 0) {
				const headEnd = rest.indexOf("\r\n\r\n");
				if (headEnd < 0) break;
				const head = rest.slice(0, headEnd);
				const length = Number(/content-length: (\d+)/i.exec(head)?.[1] ?? 0);
				const body = rest.slice(headEnd + 4, headEnd + 4 + length);
				responses.push(`${head.slice(9, 12)} ${body}`);
				rest = rest.slice(headEnd + 4 + length);
			}
			resolve(responses.join(" | "));
		});
	});
}

const get = (path, extra = "") => `GET ${path} HTTP/1.1\r\nHost: x\r\n${extra}\r\n`;
const close = "Connection: close\r\n";

log(
	"slow first",
	await exchange(get("/slow") + get("/a") + get("/b") + get("/c", close)),
);
log(
	"pipelined body",
	await exchange(
		"POST /echo HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\n\r\nhello" +
			"POST /chunked HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n" +
			"3\r\nabc\r\n2\r\nde\r\n0\r\n\r\n" +
			get("/after", close),
	),
);
// Node drops the pending /ok response when its eager parse fails; Maligator answers
// /ok first. Both end the connection with a bodiless 400.
log(
	"malformed follow-up",
	(await exchange(get("/ok") + "NOT A REQUEST\r\n\r\n")).split(" | ").at(-1),
);
// Nothing after a Connection: close request is processed.
log(
	"after close",
	(await exchange(get("/first", close) + get("/ignored"))).includes("/ignored"),
);
let many = "";
for (let index = 0; index < 40; index++) many += get(`/n${index}`);
log("forty", (await exchange(many + get("/last", close))).split(" | ").length);

await new Promise((resolve) => server.close(resolve));
console.log(results.join("\n"));
