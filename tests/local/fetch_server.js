// WinterTC fetch server smoke test. Mal.serve starts an HTTP server on an
// ephemeral port; the handler returns a Response. The runner (scripts/fetchtest.ts)
// reads the port, drives it with Node's fetch, and asserts.
const server = Mal.serve({
	port: 0,
	async fetch(request) {
		if (request.url.endsWith("/created")) {
			return new Response("made", { status: 201 });
		}
		if (request.url.endsWith("/custom-reason")) {
			return new Response("custom", { status: 299, statusText: "All Fine" });
		}
		if (request.url.endsWith("/async")) {
			await new Promise((resolve) => setTimeout(resolve, 10));
			return new Response("async-done");
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
		if (request.url.endsWith("/body")) {
			return new Response("body=" + (await request.text()));
		}
		if (request.url.endsWith("/sum")) {
			const data = await request.json();
			return new Response(String(data.a + data.b));
		}
		if (request.url.endsWith("/binary")) {
			return new Response(new Uint8Array([1, 2, 3, 4, 5]), {
				headers: { "content-type": "application/octet-stream" },
			});
		}
		if (request.url.endsWith("/abuf")) {
			const ab = await request.arrayBuffer();
			return new Response("len=" + ab.byteLength);
		}
		if (request.url.endsWith("/bytes")) {
			const b = await request.bytes();
			return new Response("b=" + b[0] + "-" + b[1] + "-" + b.length);
		}
		if (request.url.endsWith("/rjson")) {
			return Response.json({ ok: true, n: 42 });
		}
		if (request.url.endsWith("/reqctor")) {
			const rr = new Request("https://x/y", {
				method: "PUT",
				body: "abc",
				headers: { "x-h": "v" },
			});
			const body = await rr.text();
			return new Response(
				`m=${rr.method},u=${rr.url},h=${rr.headers.get("x-h")},b=${body}`,
			);
		}
		if (request.url.endsWith("/respread")) {
			// Each Body is one-shot, so exercise the read methods on independent responses.
			const r = new Response("hello-resp", { status: 201, statusText: "Created" });
			const txt = await r.text();
			const ab = await new Response("hello-resp").arrayBuffer();
			const by = await new Response("hello-resp").bytes();
			return new Response(
				`t=${txt},ab=${ab.byteLength},b0=${by[0]},status=${r.status},ok=${r.ok},st=${r.statusText}`,
			);
		}
		return new Response("hello " + request.method + " " + request.url);
	},
});

console.log("PORT " + server.port);
