// HTTP throughput benchmark server (maligator / WinterTC fetch).
// Fixed port, fixed plaintext response — the analog of Node's http.createServer.
const BODY = "Hello, World!";
const printGcStats = globalThis.__mal_print_gc_stats;
const server = Mal.serve({
	port: 3111,
	fetch(request) {
		if (
			printGcStats !== undefined &&
			request.method === "POST" &&
			request.url.endsWith("/__maligator_gc_stats")
		) {
			printGcStats();
			return new Response("ok");
		}
		return new Response(BODY, { headers: { "content-type": "text/plain" } });
	},
});
console.log("PORT " + server.port);
