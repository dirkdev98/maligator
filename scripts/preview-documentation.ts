import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import * as path from "node:path";
import { siteResponse } from "../website/responses.ts";
import type { ExplorerAsset, SiteResource } from "../website/responses.ts";
import { CONTAINER_DOCS, PLAIN_DOCS } from "./generate-documentation.ts";

const directory = process.argv.includes("--container") ? CONTAINER_DOCS : PLAIN_DOCS;
const assets = JSON.parse(
	readFileSync(path.join(directory, "manifest.json"), "utf8"),
) as Array<ExplorerAsset>;
const resources = new Map<string, SiteResource>(
	assets.map((asset) => [
		asset.url,
		{
			body: readFileSync(path.join(directory, asset.file)),
			type: asset.type,
			bytes: asset.bytes,
			etag: `"${asset.digest}"`,
			documentation: true,
		},
	]),
);
for (const [url, file, type] of [
	["/", "index.html", "text/html"],
	["/compatibility", "compatibility.html", "text/html"],
	["/favicon.ico", "favicon.ico", "image/vnd.microsoft.icon"],
	["/favicon-32x32.png", "favicon-32x32.png", "image/png"],
	["/apple-touch-icon.png", "apple-touch-icon.png", "image/png"],
]) {
	resources.set(url!, { body: readFileSync(`website/${file}`), type: type! });
}
const server = createServer((request, response) => {
	void (async () => {
		try {
			const result = siteResponse(
				new Request(`http://localhost${request.url ?? "/"}`, {
					method: request.method ?? "GET",
				}),
				resources,
			);
			response.writeHead(result.status, Object.fromEntries(result.headers));
			response.end(
				request.method === "HEAD" ? undefined : Buffer.from(await result.arrayBuffer()),
			);
		} catch {
			response.writeHead(500);
			response.end("Preview failed");
		}
	})();
});
server.listen(Number(process.env.PORT ?? "0"), "127.0.0.1", () => {
	const address = server.address();
	if (address !== null && typeof address !== "string")
		console.log(`Documentation preview: http://127.0.0.1:${address.port}/docs`);
});
process.on("SIGINT", () => {
	server.close();
});
