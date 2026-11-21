import { ready } from "maligator:application";
import { serve } from "maligator:http";

const server = serve({
	hostname: "127.0.0.1",
	port: 3000,
	fetch(request) {
		if (new URL(request.url).pathname === "/") {
			return new Response("hello", { headers: { "content-type": "text/plain" } });
		}
		return new Response("Not found", { status: 404 });
	},
});
console.log(`Listening on ${server.url}`);
ready();
