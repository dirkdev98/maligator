import { embedDirectory } from "maligator:assets";
import { serve, serveAsset } from "maligator:http";

const site = embedDirectory("./public");

// The whole handler serves assets, so this server answers from native code.
const fast = serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: serveAsset(site, { fallback: "index.html", immutable: ["assets/**"] }),
});

const files = serveAsset(site, { prefix: "/static", fallback: "index.html" });
const routed = serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const { pathname } = new URL(request.url);
		if (pathname === "/api/ping") return Response.json({ pong: true });
		if (pathname === "/fast-port") return new Response(String(fast.port));
		if (pathname === "/close-fast") {
			await fast.close();
			return new Response("closed");
		}
		if (pathname === "/throw") throw new Error("handler failure");
		return files(request);
	},
});
console.log("PORT " + routed.port);
