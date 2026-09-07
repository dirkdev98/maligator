export interface ExplorerAsset {
	url: string;
	file: string;
	type: string;
	encoding?: "br";
	bytes: number;
	digest: string;
}

export interface SiteResource {
	body: string | Uint8Array<ArrayBuffer>;
	type: string;
	etag?: string;
	encoding?: "br";
	bytes?: number;
	immutable?: boolean;
	explorer?: boolean;
}

export function acceptsBrotli(header: string | null): boolean {
	if (header === null) return true;
	let wildcard = false;
	for (const item of header.toLowerCase().split(",")) {
		const [coding, ...parameters] = item.trim().split(";");
		const quality = parameters.find((value) => value.trim().startsWith("q="));
		const q = quality === undefined ? 1 : Number(quality.trim().slice(2));
		const allowed = Number.isFinite(q) && q > 0 && q <= 1;
		if (coding?.trim() === "br") return allowed;
		if (coding?.trim() === "*") wildcard = allowed;
	}
	return wildcard;
}

export function siteResponse(
	request: Request,
	resources: ReadonlyMap<string, SiteResource>,
): Response {
	let pathname = new URL(request.url).pathname;
	if (pathname === "/index.html") pathname = "/";
	if (pathname === "/compatibility.html") pathname = "/compatibility";
	if (pathname === "/explorer.html" || pathname === "/explorer/") pathname = "/explorer";
	const resource = resources.get(pathname);
	if (resource === undefined)
		return new Response(request.method === "HEAD" ? null : "Not found", { status: 404 });
	if (request.method !== "GET" && request.method !== "HEAD")
		return new Response("Method not allowed", {
			status: 405,
			headers: { Allow: "GET, HEAD" },
		});
	const headers = new Headers({
		"Content-Type": resource.type,
		"Cache-Control": resource.immutable
			? "public, max-age=31536000, immutable, no-transform"
			: "public, max-age=0, must-revalidate",
		"Referrer-Policy": "no-referrer",
		"X-Content-Type-Options": "nosniff",
		"Content-Security-Policy": resource.explorer
			? "default-src 'none'; img-src data:; style-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
			: "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
	});
	if (resource.encoding !== undefined) {
		headers.set("Vary", "Accept-Encoding");
		if (!acceptsBrotli(request.headers.get("Accept-Encoding")))
			return new Response(
				request.method === "HEAD" ? null : "This compiler asset requires Brotli support",
				{
					status: 406,
					headers: { Vary: "Accept-Encoding", "Cache-Control": "no-store" },
				},
			);
		headers.set("Content-Encoding", resource.encoding);
	}
	if (resource.etag !== undefined) {
		headers.set("ETag", resource.etag);
		const validators = request.headers
			.get("If-None-Match")
			?.split(",")
			.map((value) => {
				const tag = value.trim();
				return tag.startsWith("W/") ? tag.slice(2) : tag;
			});
		if (validators?.some((value) => value === "*" || value === resource.etag))
			return new Response(null, { status: 304, headers });
	}
	if (resource.bytes !== undefined) headers.set("Content-Length", String(resource.bytes));
	// Mal.serve suppresses HEAD bodies while deriving their GET-equivalent length.
	return new Response(resource.body, { headers });
}
