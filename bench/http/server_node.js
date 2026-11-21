// HTTP throughput benchmark server (Node.js http.createServer).
import http from "node:http";
const BODY = "Hello, World!";
const server = http.createServer((req, res) => {
	res.writeHead(200, { "Content-Type": "text/plain", "Content-Length": BODY.length });
	res.end(BODY);
});
server.listen(0, "127.0.0.1", () => console.log(`PORT ${server.address().port}`));
