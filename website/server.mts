import { readFileSync } from "node:fs";
import { siteResponse } from "./responses.ts";
import type { ExplorerAsset, SiteResource } from "./responses.ts";

const explorerRoot = mal.assets.materialize("explorer");
const pages = new Map<string, SiteResource>([
	[
		"/",
		{
			body: readFileSync(mal.assets.materialize("site"), "utf8"),
			type: "text/html; charset=utf-8",
		},
	],
	[
		"/compatibility",
		{
			body: readFileSync(mal.assets.materialize("compatibility"), "utf8"),
			type: "text/html; charset=utf-8",
		},
	],
	[
		"/explorer",
		{
			body: readFileSync(`${explorerRoot}/index.html`, "utf8"),
			type: "text/html; charset=utf-8",
			explorer: true,
		},
	],
]);
const assets = JSON.parse(
	readFileSync(`${explorerRoot}/manifest.json`, "utf8"),
) as Array<ExplorerAsset>;
for (const asset of assets) {
	pages.set(asset.url, {
		body: readFileSync(`${explorerRoot}/${asset.file}`),
		type: asset.type,
		bytes: asset.bytes,
		etag: `"${asset.digest}"`,
		encoding: asset.encoding,
		immutable: true,
		explorer: true,
	});
}
const hostname = process.env.SITE_HOST ?? "0.0.0.0";
const port = Number(process.env.PORT ?? "3000");
const server = Mal.serve({
	hostname,
	port,
	fetch: (request) => siteResponse(request, pages),
});

// eslint-disable-next-line no-console -- The standalone server needs one startup status line.
console.log(`Maligator site listening on http://${hostname}:${server.port}`);
