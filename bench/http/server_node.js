// HTTP throughput benchmark server (Node.js http.createServer).
// Fixed port, fixed plaintext response — the baseline for the maligator server.
import http from "node:http";
const BODY = "Hello, World!";
http
	.createServer((req, res) => {
		res.writeHead(200, { "Content-Type": "text/plain", "Content-Length": BODY.length });
		res.end(BODY);
	})
	.listen(3112, "127.0.0.1", () => console.log("PORT 3112"));
