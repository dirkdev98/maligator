import { describe, expect, it } from "vitest";
import { acceptsBrotli, siteResponse } from "../website/responses.ts";
import type { SiteResource } from "../website/responses.ts";

const resources = new Map<string, SiteResource>([
	["/", { body: "<h1>Overview</h1>", type: "text/html" }],
	["/explorer", { body: "<h1>Explorer</h1>", type: "text/html", explorer: true }],
	["/api/application", { body: "ready()", type: "text/html", documentation: true }],
	[
		"/api/application.md",
		{ body: "# ready", type: "text/markdown", documentation: true },
	],
	[
		"/explorer/assets/compiler.abc.wasm",
		{
			body: new Uint8Array([1, 2, 3]),
			type: "application/wasm",
			encoding: "br",
			etag: '"abc"',
			bytes: 3,
			immutable: true,
			explorer: true,
		},
	],
]);
const wasm = "http://localhost/explorer/assets/compiler.abc.wasm";

describe("website asset responses", () => {
	it("serves documentation aliases, Markdown, and same-origin search with a narrow CSP", async () => {
		for (const route of [
			"/api/application",
			"/api/application/",
			"/api/application.html",
		]) {
			const response = siteResponse(new Request(`http://localhost${route}`), resources);
			expect(await response.text()).toBe("ready()");
			const policy = response.headers.get("Content-Security-Policy")!;
			expect(policy).toContain("script-src 'self' 'wasm-unsafe-eval'");
			expect(policy).toContain("connect-src 'self'");
			expect(policy).not.toContain("script-src 'unsafe-inline'");
			expect(policy).not.toContain("'unsafe-eval'");
		}
		const markdown = siteResponse(
			new Request("http://localhost/api/application.md"),
			resources,
		);
		expect(markdown.headers.get("Content-Type")).toBe("text/markdown");
		expect(await markdown.text()).toBe("# ready");
	});
	it("negotiates Brotli with explicit exclusions taking precedence", () => {
		for (const header of [null, "br", "gzip, br;q=0.5", "*;q=1"])
			expect(acceptsBrotli(header)).toBe(true);
		for (const header of ["", "gzip", "br;q=0, *;q=1", "br;q=invalid", "br;q=2", "*;q=0"])
			expect(acceptsBrotli(header)).toBe(false);
	});
	it("serves compressed bytes with strong validators and HEAD parity", async () => {
		const get = siteResponse(
			new Request(wasm, { headers: { "Accept-Encoding": "br" } }),
			resources,
		);
		expect(get.status).toBe(200);
		expect(get.headers.get("Content-Encoding")).toBe("br");
		expect(get.headers.get("Content-Type")).toBe("application/wasm");
		expect(get.headers.get("Cache-Control")).toContain("immutable");
		expect(new Uint8Array(await get.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
		const head = siteResponse(new Request(wasm, { method: "HEAD" }), resources);
		expect(Array.from(head.headers)).toEqual(Array.from(get.headers));
		const cached = siteResponse(
			new Request(wasm, { headers: { "If-None-Match": '"other", W/"abc"' } }),
			resources,
		);
		expect(cached.status).toBe(304);
		expect(await cached.text()).toBe("");
		expect(
			siteResponse(
				new Request(wasm, {
					headers: { "Accept-Encoding": "br;q=0", "If-None-Match": '"abc"' },
				}),
				resources,
			).status,
		).toBe(406);
	});
	it("allows only mapped assets and read methods, and keeps the explorer CSP narrow", async () => {
		for (const pathname of [
			"/explorer/assets/manifest.json",
			"/explorer/assets/unknown.js",
			"/src/explorer/api.ts",
		])
			expect(
				siteResponse(new Request(`http://localhost${pathname}`), resources).status,
			).toBe(404);
		const post = siteResponse(
			new Request(wasm, { method: "POST", body: "code" }),
			resources,
		);
		expect(post.status).toBe(405);
		expect(post.headers.get("Allow")).toBe("GET, HEAD");
		const page = siteResponse(new Request("http://localhost/explorer.html"), resources);
		expect(await page.text()).toBe("<h1>Explorer</h1>");
		expect(page.headers.get("Content-Security-Policy")).toContain("'wasm-unsafe-eval'");
		expect(page.headers.get("Content-Security-Policy")).not.toContain("'unsafe-eval'");
		expect(page.headers.get("Content-Security-Policy")).not.toContain("'unsafe-inline'");
		for (const pathname of ["/", "/explorer"]) {
			const response = siteResponse(
				new Request(`http://localhost${pathname}`),
				resources,
			);
			expect(response.headers.get("Content-Security-Policy")).toContain(
				"img-src 'self' data:",
			);
		}
	});
});
