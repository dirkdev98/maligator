// HTTP throughput benchmark server (maligator / WinterTC fetch).
// Fixed port, fixed plaintext response — the analog of Node's http.createServer.
const BODY = "Hello, World!";
const server = Mal.serve({
	port: 3111,
	fetch() {
		return new Response(BODY, { headers: { "content-type": "text/plain" } });
	},
});
console.log("PORT " + server.port);
