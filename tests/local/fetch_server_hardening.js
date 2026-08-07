// Fixture for the Mal.serve hardening regressions (tests/native/fetch-hardening.test.ts).
// Every route is deliberately boring: the assertions live on the wire, not here.
const server = Mal.serve({
	port: 0,
	async fetch(request) {
		const path = request.url.slice(request.url.indexOf("/", "http://".length));

		// Echo the composed absolute URL verbatim so the test can compare it against
		// the exact bytes it sent — a truncated or over-read URL fails the compare.
		if (path.startsWith("/url")) {
			return new Response(request.url);
		}
		if (path.startsWith("/len")) {
			const buffer = await request.arrayBuffer();
			return new Response("len=" + buffer.byteLength);
		}
		if (path === "/head") {
			return new Response("headbody");
		}
		if (path === "/no-content") {
			return new Response(null, { status: 204 });
		}
		if (path === "/not-modified") {
			return new Response(null, { status: 304 });
		}
		// A handler that only settles after an await: the peer may be long gone by
		// the time the promise resolves.
		if (path === "/slow") {
			await new Promise((resolve) => setTimeout(resolve, 40));
			return new Response("slow");
		}
		return new Response("ok");
	},
});
console.log("PORT " + server.port);
