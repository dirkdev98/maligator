import { readFileSync } from "node:fs";

const pages = new Map([
	["/", readFileSync(mal.assets.materialize("site"), "utf8")],
	["/compatibility", readFileSync(mal.assets.materialize("compatibility"), "utf8")],
]);
const port = Number(process.env.PORT ?? "3000");

const server = Mal.serve({
	hostname: "0.0.0.0",
	port,
	fetch(request) {
		const url = new URL(request.url);
		const pathname =
			url.pathname === "/index.html"
				? "/"
				: url.pathname === "/compatibility.html"
					? "/compatibility"
					: url.pathname;
		const html = pages.get(pathname);
		if (html === undefined) {
			return new Response("Not found", { status: 404 });
		}
		if (request.method !== "GET" && request.method !== "HEAD") {
			return new Response("Method not allowed", {
				status: 405,
				headers: { Allow: "GET, HEAD" },
			});
		}
		return new Response(request.method === "HEAD" ? null : html, {
			headers: {
				"Cache-Control": "public, max-age=300",
				"Content-Security-Policy":
					"default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
				"Content-Type": "text/html; charset=utf-8",
				"Referrer-Policy": "no-referrer",
				"X-Content-Type-Options": "nosniff",
			},
		});
	},
});

// eslint-disable-next-line no-console -- The standalone server needs one startup status line.
console.log(`Maligator site listening on http://0.0.0.0:${server.port}`);
