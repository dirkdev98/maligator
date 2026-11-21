import { serve } from "maligator:http";

// HTTP throughput benchmark server (maligator / WinterTC fetch).
// Fixed plaintext response matching the Node.js fixture.
const BODY = "Hello, World!";
const server = serve({
	port: 0,
	fetch() {
		return new Response(BODY, { headers: { "content-type": "text/plain" } });
	},
});
console.log("PORT " + server.port);
