// Sync-handler variant (no async/await) to isolate whether the STRESS segfault is
// in the fetch server code or the pre-existing async-frame rooting gap.
const server = Mal.serve({
	port: 0,
	fetch(request) {
		if (request.url.endsWith("/created")) {
			return new Response("made", { status: 201 });
		}
		if (request.url.endsWith("/json")) {
			return new Response('{"ok":true}', {
				headers: { "content-type": "application/json" },
			});
		}
		if (request.url.endsWith("/echo")) {
			return new Response(request.headers.get("x-test") || "none");
		}
		if (request.url.endsWith("/cookies")) {
			const headers = new Headers();
			headers.append("Set-Cookie", "a=1; Path=/");
			headers.append("set-cookie", "b=2; Path=/");
			return new Response("cookies", { headers });
		}
		if (request.url.endsWith("/binary")) {
			// Binary Response body exercises the BufferSource path under STRESS.
			return new Response(new Uint8Array([1, 2, 3, 4, 5]), {
				headers: { "content-type": "application/octet-stream" },
			});
		}
		if (request.url.endsWith("/rjson")) {
			// Response.json exercises stringify + body + headers alloc under STRESS.
			return Response.json({ ok: true, n: 42 });
		}
		return new Response("hello " + request.method + " " + request.url);
	},
});

console.log("PORT " + server.port);
